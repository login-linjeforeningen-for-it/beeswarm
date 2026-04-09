import WebSocket from 'ws'
import sendMetrics from '#utils/sendMetrics.ts'
import config from '#constants'
import { promptModel } from '#utils/modelApi.ts'

if (!config.ws_api) {
    console.error('Missing WS API')
    process.exit(1)
}

const MAX_BACKOFF = 30000
let backoff = 1000
let interval: NodeJS.Timeout | null = null
let connecting = false
let socket: WebSocket | null = null
let prompting = false

function getSocketUrls(baseUrl: string) {
    const normalizedBaseUrl = baseUrl.replace(/\/+$/, '')
    const webSocketBaseUrl = normalizedBaseUrl.replace(/^http/, 'ws')
    const rootBaseUrl = webSocketBaseUrl.replace(/\/api$/, '')

    return [...new Set([
        `${webSocketBaseUrl}/client/ws/beeswarm`,
        `${rootBaseUrl}/client/ws/beeswarm`,
    ])]
}

function retryConnection() {
    console.log(`Reconnecting in ${backoff / 1000}s...`)
    setTimeout(connect, backoff)
    backoff = Math.min(backoff * 2, MAX_BACKOFF)
}

async function handleSocketMessage(rawMessage: WebSocket.RawData) {
    try {
        const msg = JSON.parse(rawMessage.toString()) as { type?: string }

        if (msg.type !== 'join' && msg.type !== 'update') {
            console.log('Received:', msg)
        }

        if (msg.type !== 'prompt_request') {
            return
        }

        if (prompting) {
            socket?.send(JSON.stringify({
                type: 'prompt_error',
                conversationId: (msg as GPT_PromptRequest).conversationId,
                clientName: (msg as GPT_PromptRequest).clientName || null,
                error: 'Model is already processing another prompt.',
                timestamp: new Date().toISOString(),
            }))
            return
        }

        prompting = true
        await promptModel(msg as GPT_PromptRequest, (event) => {
            if (socket?.readyState === WebSocket.OPEN) {
                socket.send(event)
            }
        })
    } catch (err) {
        console.error('Invalid message from server:', err)
    } finally {
        prompting = false
    }
}

function connect() {
    if (socket || connecting) return

    const wsApi = config.ws_api
    if (!wsApi) {
        console.error('Missing WS API')
        process.exit(1)
    }

    const socketUrls = getSocketUrls(wsApi)

    const attemptConnection = (index: number) => {
        const targetUrl = socketUrls[index]
        if (!targetUrl) {
            connecting = false
            retryConnection()
            return
        }

        connecting = true
        console.log(`Connecting to ${targetUrl} ...`)

        const candidate = new WebSocket(targetUrl)
        let opened = false
        let retryScheduled = false

        const scheduleRetry = () => {
            if (retryScheduled) return
            retryScheduled = true
            connecting = false
            socket = null
            retryConnection()
        }

        const tryNextUrl = () => {
            if (index + 1 >= socketUrls.length) {
                scheduleRetry()
                return
            }

            connecting = false
            socket = null
            attemptConnection(index + 1)
        }

        candidate.on('open', () => {
            opened = true
            socket = candidate
            connecting = false
            backoff = 1000
            console.log(`Connected to WebSocket server via ${targetUrl}.`)

            interval = setInterval(() => {
                if (socket?.readyState === WebSocket.OPEN) {
                    sendMetrics(socket).catch(error => {
                        console.error('Failed to send metrics:', error)
                    })
                }
            }, 1000)
        })

        candidate.on('message', (rawMessage) => {
            void handleSocketMessage(rawMessage)
        })

        candidate.on('unexpected-response', (_, response) => {
            console.warn(`WebSocket upgrade failed for ${targetUrl}: ${response.statusCode}`)
            tryNextUrl()
        })

        candidate.on('close', () => {
            if (interval) {
                clearInterval(interval)
                interval = null
            }

            if (!opened) {
                console.warn(`WebSocket connection closed before opening for ${targetUrl}.`)
                tryNextUrl()
                return
            }

            console.warn('WebSocket connection closed.')
            socket = null
            scheduleRetry()
        })

        candidate.on('error', (err) => {
            if (JSON.stringify(err).includes('ECONNREFUSED')) {
                console.error('Unable to reach BeeSwarm.')
                return
            }

            console.error(`WebSocket error for ${targetUrl}:`, err)
        })
    }

    attemptConnection(0)
}

connect()
