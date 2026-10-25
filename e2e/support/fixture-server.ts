import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PAGE_DIR = fileURLToPath(new URL('../fixtures/video-page/', import.meta.url));

const ROUTES: Record<string, { file: string; type: string }> = {
  '/watch/fixture': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/fixture.js': { file: 'fixture.js', type: 'text/javascript; charset=utf-8' },
  '/media/silent-600s.wav': { file: 'media/silent-600s.wav', type: 'audio/wav' },
};

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { pathname } = new URL(req.url ?? '/', 'http://127.0.0.1');
  const route = ROUTES[pathname];
  if (!route || (req.method !== 'GET' && req.method !== 'HEAD')) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return;
  }
  const filePath = join(PAGE_DIR, route.file);
  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end(`missing ${route.file} (run npm run env:reset)`);
    return;
  }

  const headers: Record<string, string | number> = {
    'content-type': route.type,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  };
  // Byte ranges let the media element seek without downloading the whole file.
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  let start = 0;
  let end = size - 1;
  let status = 200;
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    } else {
      start = Math.max(0, size - Number(range[2]));
    }
    if (start > end || start >= size) {
      res.writeHead(416, { 'content-range': `bytes */${size}` }).end();
      return;
    }
    status = 206;
    headers['content-range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['content-length'] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(filePath, { start, end }).pipe(res);
}

export async function startFixtureServer(port = 8790): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const actualPort = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${actualPort}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
