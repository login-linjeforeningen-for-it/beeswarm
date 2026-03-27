import packagejson from '../package.json'

const config = {
    url: {
        api: 'http://localhost:8080/api',
        // api: 'https://api.beeswarm.login.no/api',
        api_ws: 'ws://localhost:8080/api',
        // api_ws: 'wss://api.beeswarm.login.no/api',
    },
    version: packagejson.version,
    light: 'shadow-[inset_0_1px_0_rgba(255,255,255,0.2),0_4px_8px_rgba(0,0,0,0.4)] backdrop-blur-md'
}

export default config
