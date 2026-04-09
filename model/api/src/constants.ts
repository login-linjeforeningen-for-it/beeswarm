import dotenv from 'dotenv'

dotenv.config({ path: '../.env' })

const requiredEnvironmentVariables = [
    'API',
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
    ws_api: env.API,
    model_api: process.env.MODEL_API || 'http://127.0.0.1:8081'
}

export default config
