import os from "os"
import si from "systeminformation"
import getGpuUsage from './gpu/mac.ts'
import { getModelState } from './modelState.ts'

export default async function metrics(): Promise<GPT_Client> {
    const name = os.hostname()

    // RAM info
    const totalMem = os.totalmem()
    const freeMem = os.freemem()
    const usedMem = totalMem - freeMem
    const ram: GPT_RAM[] = [
        {
            name: "System RAM",
            load: usedMem / totalMem,
        }
    ]

    // CPU info
    const cpuInfo = await si.cpu()
    const loadInfo = await si.currentLoad()
    const cpu: GPT_CPU[] = loadInfo.cpus.map((core, index) => ({
        name: `${cpuInfo.manufacturer} ${cpuInfo.brand} Core ${index + 1}`,
        load: core.load / 100,
    }))

    // GPU info
    let gpu: GPT_GPU[]
    const graphics = await si.graphics()
    const mac = process.platform === 'darwin'
    if (mac) {
        let gpuMetrics: Awaited<ReturnType<typeof getGpuUsage>> | null = null
        try {
            gpuMetrics = await getGpuUsage()
        } catch (error) {
            console.warn('Falling back to zeroed GPU metrics:', error)
        }

        gpu = graphics.controllers.map((g) => ({
            name: g.model,
            load: gpuMetrics?.hwActiveResidency || 0,
            cores: g.cores,
            metrics: gpuMetrics || undefined,
        }))
    } else {
        gpu = graphics.controllers.map((g) => ({
            name: g.model,
            load: (g.utilizationGpu || 0) / 100,
        }))
    }

    return { name, ram, cpu, gpu, model: getModelState() }
}
