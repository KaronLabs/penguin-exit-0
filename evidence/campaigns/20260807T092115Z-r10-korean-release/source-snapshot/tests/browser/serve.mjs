import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../../');
export const PORT = 4173;
export const HOST = '127.0.0.1';
export const SERVER_URL = `http://${HOST}:${PORT}`;
export const AVAILABILITY_TIMEOUT_MS = 1000;

const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8'
};

function createRequestHandler() {
    return async (req, res) => {
        try {
            const decodedUrl = decodeURIComponent(req.url.split('?')[0]);
            let safePath = path.normalize(decodedUrl).replace(/^(\.\.[\/\\])+/, '');
            if (safePath === '/' || safePath === '\\') {
                safePath = '/index.html';
            }

            const filePath = path.join(rootDir, safePath);

            // Security check: ensure path is within rootDir
            if (!filePath.startsWith(rootDir)) {
                res.writeHead(403, { 'Content-Type': 'text/plain' });
                res.end('Forbidden');
                return;
            }

            const ext = path.extname(filePath);
            const contentType = mimeTypes[ext] || 'application/octet-stream';
            const data = await fs.readFile(filePath);

            res.writeHead(200, { 'Content-Type': contentType });
            res.end(data);
        } catch (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
        }
    };
}

export function startStaticServer({ port = PORT, host = HOST } = {}) {
    const server = http.createServer(createRequestHandler());

    return new Promise((resolve, reject) => {
        const onError = (error) => {
            server.off('listening', onListening);
            reject(error);
        };
        const onListening = () => {
            server.off('error', onError);
            resolve(server);
        };

        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
    });
}

export function stopStaticServer(server) {
    return new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    });
}

export function isStaticServerAvailable() {
    return new Promise((resolve) => {
        let settled = false;
        let request;
        let timeout;
        const settle = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            resolve(value);
        };

        timeout = setTimeout(() => {
            request.destroy();
            settle(false);
        }, AVAILABILITY_TIMEOUT_MS);

        request = http.get({ host: HOST, port: PORT, path: '/', agent: false }, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => { body += chunk; });
            response.on('end', () => settle(response.statusCode === 200 && body.includes('id="btn-produce"')));
            response.on('aborted', () => settle(false));
            response.on('error', () => settle(false));
        });

        request.on('abort', () => settle(false));
        request.on('error', () => settle(false));
    });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await startStaticServer();
    console.log(`SERVER_READY ${SERVER_URL}`);
}
