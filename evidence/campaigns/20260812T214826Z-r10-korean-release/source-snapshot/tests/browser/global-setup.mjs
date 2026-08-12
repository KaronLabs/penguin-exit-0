import { isStaticServerAvailable, startStaticServer, stopStaticServer } from './serve.mjs';

export default async function globalSetup() {
    if (await isStaticServerAvailable()) {
        return;
    }

    const server = await startStaticServer();

    return async () => {
        await stopStaticServer(server);
    };
}
