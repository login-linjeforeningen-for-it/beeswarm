import metrics from '#utils/metrics.ts'
import { syncModelRuntimeMetrics } from '#utils/modelApi.ts'
import { WebSocket as WS } from 'ws'

export default async function sendMetrics(sender: WS) {
    await syncModelRuntimeMetrics()

    const payload = JSON.stringify({
        type: 'update',
        client: await metrics(),
        timestamp: new Date().toISOString()
    })

    sender.send(payload)
}
