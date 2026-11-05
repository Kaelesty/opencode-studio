#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Studio } from './lib/studio.js';
import { runtimeAgent, runtimeCatalog } from './lib/runtime.js';

const publicDirectory = fileURLToPath(new URL('./public/', import.meta.url));
const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };

async function body(request) {
  let value = '';
  for await (const part of request) {
    value += part;
    if (Buffer.byteLength(value) > 2 * 1024 * 1024) { const error = new Error('Запрос превышает 2 МБ'); error.status = 413; throw error; }
  }
  try { return JSON.parse(value); } catch { throw new Error('Ожидается JSON'); }
}

export function createServer(studio, runtime = runtimeAgent, catalogReader = runtimeCatalog) {
  let cachedCatalog;
  return http.createServer(async (request, response) => {
    const origin = `http://127.0.0.1:${request.socket.localPort}`;
    const headers = {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    };
    const json = (status, value) => { response.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); };
    try {
      if (request.headers.host !== `127.0.0.1:${request.socket.localPort}` || (request.headers.origin && request.headers.origin !== origin) || request.headers['sec-fetch-site'] === 'cross-site') return json(403, { error: 'Только same-origin localhost-запросы' });
      const url = new URL(request.url, origin);
      if (request.method === 'GET' && assets[url.pathname]) {
        const [name, type] = assets[url.pathname];
        response.writeHead(200, { ...headers, 'Content-Type': `${type}; charset=utf-8` });
        response.end(fs.readFileSync(path.join(publicDirectory, name)));
      } else if (request.method === 'GET' && url.pathname === '/api/state') json(200, studio.state());
      else if (request.method === 'GET' && url.pathname === '/api/cli') json(200, studio.cli());
      else if (request.method === 'GET' && url.pathname === '/api/runtime-agent') json(200, await runtime(url.searchParams.get('id')));
      else if (request.method === 'GET' && url.pathname === '/api/catalog') {
        if (!cachedCatalog || url.searchParams.has('refresh')) {
          try { cachedCatalog = await catalogReader(); }
          catch { throw new Error('Каталог OpenCode недоступен. Проверьте фоновый сервис и обновите каталог.'); }
        }
        json(200, studio.inventory(cachedCatalog));
      }
      else if (request.method === 'GET' && url.pathname === '/api/document') json(200, studio.document(url.searchParams.get('id')));
      else if (request.method === 'GET' && url.pathname === '/api/file') json(200, studio.readFile(url.searchParams.get('name')));
      else if (request.method === 'POST' && ['/api/save', '/api/restore', '/api/preview'].includes(url.pathname)) {
        if (request.headers['x-studio-request'] !== '1' || request.headers.origin !== origin || !request.headers['content-type']?.startsWith('application/json')) return json(403, { error: 'Нужен same-origin JSON-запрос из Studio' });
        const data = await body(request);
        const action = url.pathname.slice(5);
        json(200, studio[action](data));
      } else json(404, { error: 'Не найдено' });
    } catch (error) {
      // Filesystem errors can contain private paths; do not send or log their messages.
      json(error.status || 400, { error: error.code ? `Ошибка файловой системы (${error.code})` : error.message });
    }
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('OpenCode Studio\n\nUsage: opencode-studio [--port 4317] [--no-open] [--config DIR] [--history DIR]\n\nOnly listens on 127.0.0.1. No OpenCode changes until Save.\nHistory is encrypted locally; keep its key to retain rollback access.');
    return;
  }
  let port = 4317;
  let root = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode');
  let historyDirectory;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--no-open') continue;
    if (!['--port', '--config', '--history'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Неизвестный аргумент; используйте --help');
    const option = args[i++];
    if (option === '--port') port = Number(args[i]);
    if (option === '--config') root = path.resolve(args[i]);
    if (option === '--history') historyDirectory = path.resolve(args[i]);
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Порт должен быть целым числом 0–65535');
  root = fs.realpathSync(root);
  const id = crypto.createHash('sha256').update(root).digest('hex').slice(0, 16);
  historyDirectory ||= path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 'opencode-studio', id);
  const studio = new Studio(root, historyDirectory);
  const server = createServer(studio);
  const cleanup = () => { server.close(); studio.close(); };
  process.once('SIGINT', () => { cleanup(); process.exit(0); });
  process.once('SIGTERM', () => { cleanup(); process.exit(0); });
  server.on('error', error => {
    if (error.code === 'EADDRINUSE' && !args.includes('--port')) { server.listen(0, '127.0.0.1'); return; }
    studio.close();
    console.error('Не удалось запустить сервер:', error.code || 'unknown');
    process.exitCode = 1;
  });
  server.once('listening', () => {
    const url = `http://127.0.0.1:${server.address().port}`;
    console.log(`\n  OpenCode Studio\n  ${url}\n\n  Global configuration · changes require Save\n  Ctrl+C to stop\n`);
    if (!args.includes('--no-open')) {
      const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
      const child = spawn(command, [url], { stdio: 'ignore' });
      child.on('error', () => console.log('Откройте локальную ссылку вручную.'));
      child.unref();
    }
  });
  server.listen(port, '127.0.0.1');
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(error.code ? `Ошибка запуска (${error.code})` : error.message);
  process.exitCode = 1;
});
