import { exec } from 'child_process'

type GpuMetrics = {
    hwActiveFrequency: string                       // "389 MHz"
    hwActiveResidency: number                       // 0.0927 (9.27%)
    hwFrequencyBreakdown: Record<string, number>    // MHz => fraction
    swRequestedState: Record<string, number>        // P1..P6 => %
    idleResidency: number                           // 0.9073
    power: string                                   // "50 mW"
}

export default function getGpuUsage(): Promise<GpuMetrics> {
    return new Promise((resolve, reject) => {
        exec('sudo powermetrics --samplers gpu_power -i500 -n1', (err, stdout, stderr) => {
            if (err) {
                return reject(err)
            }

            try {
                const lines = stdout.split('\n')

                let hwActiveFrequency = ''
                let hwActiveResidency = 0
                let hwFrequencyBreakdown: Record<string, number> = {}
                let swRequestedState: Record<string, number> = {}
                let idleResidency = 0
                let power = ''

                for (const line of lines) {
                    const trimmed = line.trim()

                    // GPU HW active frequency
                    if (trimmed.startsWith('GPU HW active frequency:')) {
                        hwActiveFrequency = trimmed.split(':')[1].trim()
                    }

                    // GPU HW active residency
                    if (trimmed.startsWith('GPU HW active residency:')) {
                        const match = trimmed.match(/([\d.]+)%/g)
                        if (match) {
                            hwActiveResidency = parseFloat(match[0]) / 100

                            // Breakdown by MHz
                            const freqParts = trimmed.split('(')[1].split(')')[0].split(/\s+/);
                            for (let i = 0; i < freqParts.length; i += 2) {
                                const freq = freqParts[i].replace('MHz:', '')
                                const percent = parseFloat(freqParts[i + 1].replace('%', '')) / 100
                                hwFrequencyBreakdown[freq] = percent
                            }
                        }
                    }

                    // GPU SW requested state
                    if (trimmed.startsWith('GPU SW requested state:')) {
                        const match = trimmed.match(/\(.*\)/);
                        if (match) {
                            const states = match[0].replace(/[()]/g, '').split(/\s+/)
                            for (let i = 0; i < states.length; i += 2) {
                                swRequestedState[states[i].replace(':', '')] = parseFloat(states[i + 1].replace('%', ''))
                            }
                        }
                    }

                    // GPU idle residency
                    if (trimmed.startsWith('GPU idle residency:')) {
                        idleResidency = parseFloat(trimmed.split(':')[1].replace('%', '').trim()) / 100
                    }

                    // GPU Power
                    if (trimmed.startsWith('GPU Power:')) {
                        power = trimmed.split(':')[1].trim()
                    }
                }

                resolve({
                    hwActiveFrequency,
                    hwActiveResidency,
                    hwFrequencyBreakdown,
                    swRequestedState,
                    idleResidency,
                    power,
                })
            } catch (parseErr) {
                reject(parseErr)
            }
        })
    })
}
