const modelState: GPT_ModelMetrics = {
    conversationId: null,
    status: 'idle',
    currentTokens: 0,
    maxTokens: 0,
    promptTokens: 0,
    generatedTokens: 0,
    contextTokens: 0,
    contextMaxTokens: 0,
    tps: 0,
    lastUpdated: null,
    lastError: null,
}

export function getModelState() {
    return {
        ...modelState,
    }
}

export function updateModelState(partial: Partial<GPT_ModelMetrics>) {
    Object.assign(modelState, partial)

    if (!partial.lastUpdated) {
        modelState.lastUpdated = new Date().toISOString()
    }

    modelState.currentTokens = modelState.contextTokens || (modelState.promptTokens + modelState.generatedTokens)
}

export function resetModelState() {
    updateModelState({
        conversationId: null,
        status: 'idle',
        currentTokens: 0,
        maxTokens: 0,
        promptTokens: 0,
        generatedTokens: 0,
        contextTokens: 0,
        contextMaxTokens: modelState.contextMaxTokens,
        tps: 0,
        lastError: null,
    })
}
