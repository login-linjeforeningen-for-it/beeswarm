import config from '#constants'
import { getModelState, updateModelState } from '#utils/modelState.ts'

const DEFAULT_MAX_TOKENS = 512

let contextCache = {
    fetchedAt: 0,
    total: 0,
}

function modelUrl(path: string) {
    return `${config.model_api}${path}`
}

export async function fetchSlotMetrics() {
    try {
        const response = await fetch(modelUrl('/slots'))
        if (!response.ok) {
            throw new Error(`Failed to fetch slots: ${response.status}`)
        }

        const slots = await response.json() as GPT_LlamaSlot[]
        if (!Array.isArray(slots) || !slots.length) {
            return null
        }

        const activeSlot = slots.find(slot => slot.is_processing) || slots[0]
        if (!activeSlot) {
            return null
        }

        if (activeSlot.n_ctx) {
            contextCache = {
                fetchedAt: Date.now(),
                total: activeSlot.n_ctx,
            }
        }

        return activeSlot
    } catch (error) {
        console.warn('Unable to fetch model slot metrics:', error)
        return null
    }
}

export async function syncModelRuntimeMetrics() {
    const slot = await fetchSlotMetrics()
    if (!slot) {
        return getModelState()
    }

    const generatedTokens = slot.next_token?.n_decoded || 0
    const contextMaxTokens = slot.n_ctx || contextCache.total || getModelState().contextMaxTokens
    const requestedMaxTokens = slot.params?.max_tokens ?? getModelState().maxTokens
    const maxTokens = requestedMaxTokens && requestedMaxTokens > 0 ? requestedMaxTokens : DEFAULT_MAX_TOKENS

    updateModelState({
        status: slot.is_processing ? (generatedTokens > 0 ? 'generating' : 'preparing') : getModelState().status,
        generatedTokens: Math.max(generatedTokens, getModelState().generatedTokens),
        maxTokens,
        contextMaxTokens,
        contextTokens: Math.max(getModelState().promptTokens + generatedTokens, getModelState().contextTokens),
    })

    return getModelState()
}

async function fetchContextMaxTokens() {
    if (contextCache.total && Date.now() - contextCache.fetchedAt < 30000) {
        return contextCache.total
    }

    const slot = await fetchSlotMetrics()
    return slot?.n_ctx || contextCache.total || 0
}

async function countTokens(content: string) {
    if (!content) {
        return 0
    }

    try {
        const response = await fetch(modelUrl('/tokenize'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                content,
            }),
        })

        if (!response.ok) {
            throw new Error(`Failed to tokenize: ${response.status}`)
        }

        const tokens = await response.json() as number[]
        return Array.isArray(tokens) ? tokens.length : 0
    } catch (error) {
        console.warn('Unable to count tokens:', error)
        return 0
    }
}

async function renderChatPrompt(messages: GPT_ChatMessage[]) {
    try {
        const response = await fetch(modelUrl('/apply-template'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                messages,
            }),
        })

        if (!response.ok) {
            throw new Error(`Failed to apply chat template: ${response.status}`)
        }

        const payload = await response.json() as { prompt?: string }
        return payload.prompt || messages.map(message => message.content).join('\n')
    } catch (error) {
        console.warn('Unable to render chat prompt:', error)
        return messages.map(message => message.content).join('\n')
    }
}

function toPromptEvent(type: 'prompt_started' | 'prompt_delta' | 'prompt_complete' | 'prompt_error', payload: Record<string, unknown>) {
    return JSON.stringify({
        type,
        timestamp: new Date().toISOString(),
        ...payload,
    })
}

async function parseChatStream(
    body: ReadableStream<Uint8Array>,
    request: GPT_PromptRequest,
    send: (event: string) => void,
) {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let content = ''
    let completionId: string | null = null
    const startedAt = Date.now()

    send(toPromptEvent('prompt_started', {
        conversationId: request.conversationId,
        clientName: request.clientName || null,
        metrics: getModelState(),
    }))

    while (true) {
        const { done, value } = await reader.read()
        if (done) {
            break
        }

        buffer += decoder.decode(value, { stream: true })
        const events = buffer.split('\n\n')
        buffer = events.pop() || ''

        for (const event of events) {
            const lines = event
                .split('\n')
                .map(line => line.trim())
                .filter(Boolean)

            for (const line of lines) {
                if (!line.startsWith('data:')) {
                    continue
                }

                const data = line.slice(5).trim()
                if (!data || data === '[DONE]') {
                    continue
                }

                const payload = JSON.parse(data) as {
                    id?: string
                    choices?: Array<{
                        delta?: { content?: string }
                        finish_reason?: string | null
                    }>
                    timings?: {
                        cache_n?: number
                        prompt_n?: number
                        predicted_n?: number
                        predicted_per_second?: number
                    }
                }

                completionId = payload.id || completionId

                const delta = payload.choices?.[0]?.delta?.content || ''
                if (delta) {
                    content += delta
                }

                const timings = payload.timings
                if (timings) {
                    updateModelState({
                        promptTokens: timings.prompt_n || getModelState().promptTokens,
                        generatedTokens: timings.predicted_n || getModelState().generatedTokens,
                        contextTokens: (timings.cache_n || 0) + (timings.prompt_n || 0) + (timings.predicted_n || 0),
                        currentTokens: (timings.prompt_n || 0) + (timings.predicted_n || 0),
                        tps: timings.predicted_per_second || getModelState().tps,
                    })
                } else if (delta) {
                    const generatedTokens = getModelState().generatedTokens + 1
                    updateModelState({
                        generatedTokens,
                        currentTokens: getModelState().promptTokens + generatedTokens,
                        contextTokens: getModelState().promptTokens + generatedTokens,
                        tps: generatedTokens / Math.max((Date.now() - startedAt) / 1000, 0.001),
                    })
                }

                if (delta || timings) {
                    send(toPromptEvent('prompt_delta', {
                        conversationId: request.conversationId,
                        completionId,
                        clientName: request.clientName || null,
                        delta,
                        content,
                        metrics: getModelState(),
                    }))
                }
            }
        }
    }

    return {
        completionId,
        content,
    }
}

export async function promptModel(request: GPT_PromptRequest, send: (event: string) => void) {
    const currentState = getModelState()
    if (currentState.status === 'preparing' || currentState.status === 'generating') {
        throw new Error('Model is already handling another prompt.')
    }

    const maxTokens = request.maxTokens && request.maxTokens > 0 ? request.maxTokens : DEFAULT_MAX_TOKENS
    const promptSource = await renderChatPrompt(request.messages)
    const [promptTokens, contextMaxTokens] = await Promise.all([
        countTokens(promptSource),
        fetchContextMaxTokens(),
    ])

    updateModelState({
        conversationId: request.conversationId,
        status: 'preparing',
        maxTokens,
        promptTokens,
        generatedTokens: 0,
        currentTokens: promptTokens,
        contextTokens: promptTokens,
        contextMaxTokens,
        tps: 0,
        lastError: null,
    })

    try {
        const response = await fetch(modelUrl('/v1/chat/completions'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer no-key',
            },
            body: JSON.stringify({
                model: 'beeswarm',
                messages: request.messages,
                max_tokens: maxTokens,
                temperature: request.temperature ?? 0.7,
                stream: true,
                timings_per_token: true,
            }),
        })

        if (!response.ok || !response.body) {
            throw new Error(`Model request failed with status ${response.status}`)
        }

        const streamed = await parseChatStream(response.body, request, send)
        const [generatedTokens, contextMax] = await Promise.all([
            countTokens(streamed.content),
            fetchContextMaxTokens(),
        ])

        const finalPromptTokens = getModelState().promptTokens || promptTokens
        const finalGeneratedTokens = Math.max(generatedTokens, getModelState().generatedTokens)
        updateModelState({
            status: 'idle',
            promptTokens: finalPromptTokens,
            generatedTokens: finalGeneratedTokens,
            currentTokens: finalPromptTokens + finalGeneratedTokens,
            contextTokens: finalPromptTokens + finalGeneratedTokens,
            contextMaxTokens: contextMax || contextMaxTokens,
            tps: getModelState().tps,
        })

        send(toPromptEvent('prompt_complete', {
            conversationId: request.conversationId,
            completionId: streamed.completionId,
            clientName: request.clientName || null,
            content: streamed.content,
            metrics: getModelState(),
        }))

        return streamed.content
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown model error'
        updateModelState({
            status: 'error',
            lastError: message,
            tps: 0,
        })

        send(toPromptEvent('prompt_error', {
            conversationId: request.conversationId,
            clientName: request.clientName || null,
            error: message,
            metrics: getModelState(),
        }))

        throw error
    } finally {
        const state = getModelState()
        if (state.status === 'preparing' || state.status === 'generating') {
            updateModelState({
                status: 'idle',
            })
        }
    }
}
