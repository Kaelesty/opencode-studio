import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Studio } from '../lib/studio.js';
import { fixture } from './fixture.js';

const f = fixture();
let studio, server;
let stage = 'prepare';
try {
  const home = path.join(f.directory, 'home');
  fs.mkdirSync(home);
  f.put('opencode.jsonc', '{"$schema":"https://opencode.ai/config.json","update":"disable","default_agent":"assistant"}');
  f.put('agents/assistant.md', '---\nmode: primary\n---\nSynthetic test agent.');
  f.put('skills/ponytail/SKILL.md', '---\nname: Ponytail\n---\nSynthetic required skill.');
  studio = new Studio(f.root, f.history, { home });
  studio.save({ revision: studio.state().revision, title: 'Plugin load test', edits: [{ type: 'agent', id: 'assistant', settings: { mode: 'primary', permissions: [{ action: 'skill', resource: 'ponytail', effect: 'force' }] }, prompt: 'Synthetic test agent.' }] });

  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const password = 'synthetic-test-only';
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR, OPENCODE_PASSWORD: password, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'), XDG_STATE_HOME: path.join(home, '.local/state'), XDG_CACHE_HOME: path.join(home, '.cache') };
  server = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: f.root, env, stdio: 'ignore' });
  let startupError;
  server.on('error', error => { startupError = error.code; });
  const headers = { Authorization: 'Basic ' + Buffer.from('opencode:' + password).toString('base64') };
  stage = 'startup';
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (startupError || server.exitCode !== null) break;
    try { ready = (await fetch(origin + '/api/info', { headers, signal: AbortSignal.timeout(1000) })).ok; } catch { /* Bounded readiness wait for this test-owned server. */ }
    if (ready) break;
    await delay(250);
  }
  if (!ready) throw new Error();

  const api = async endpoint => {
    const url = new URL(endpoint, origin);
    url.searchParams.set('location[directory]', f.root);
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error();
    return response.json();
  };
  stage = 'agent registry';
  await api('/api/agent');
  stage = 'plugin activation';
  const { data: plugins } = await api('/api/plugin');
  const own = plugins.find(p => p.id === 'opencode-studio.required-skills');
  if (own?.state?.status !== 'active') {
    console.error(JSON.stringify({ pluginStates: plugins.map(p => ({ studio: p.id === 'opencode-studio.required-skills' || JSON.stringify(p.source).includes('studio-required-skills'), status: p.state.status })) }));
    throw new Error();
  }
  console.log('Native OpenCode plugin load: active. Isolated config/home/data and dedicated test server; no model requests.');
} catch {
  console.error(`Native plugin load check failed at ${stage}. Raw CLI/API output suppressed.`);
  process.exitCode = 1;
} finally {
  if (server?.pid && server.exitCode === null && server.signalCode === null) {
    const stopped = once(server, 'exit');
    server.kill('SIGTERM');
    await Promise.race([stopped, delay(3000)]);
    if (server.exitCode === null && server.signalCode === null) { server.kill('SIGKILL'); await stopped; }
  }
  studio?.close();
  f.cleanup();
}
