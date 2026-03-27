import dotenv from 'dotenv'

dotenv.config({ path: '../.env' })

const requiredEnvironmentVariables: string[] = [
    
]

const missingVariables = requiredEnvironmentVariables.filter(
    (key) => !process.env[key]
)

if (missingVariables.length > 0) {
    throw new Error(
        'Missing essential environment variables:\n' +
        missingVariables
            .map((key) => `${key}: ${process.env[key] || 'undefined'}`)
            .join('\n')
    )
}

const env = Object.fromEntries(
    requiredEnvironmentVariables.map((key) => [key, process.env[key]])
)

const config = {
    PORT: env.API_PORT,
    CACHE_TTL: 30000
}

export default config
