import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { Studio } from '../lib/studio.js';
import { createServer } from '../server.js';
import { fixture } from './fixture.js';

async function setup(t) {
  const f = fixture();
  const studio = new Studio(f.root, f.history, { home: f.directory });
  const server = createServer(studio);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); studio.close(); f.cleanup(); });
  return { origin, studio };
}

test('HTTP serves the UI and masked state with restrictive browser headers', async t => {
  const { origin } = await setup(t);
  const response = await fetch(origin);
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  assert.ok((await response.text()).includes('OpenCode Studio'));
  const state = await (await fetch(origin + '/api/state')).text();
  assert.ok(!state.includes('fixture-secret-value'));
  assert.equal((await fetch(origin + '/lib/history.js')).status, 404);
  assert.equal((await fetch(origin + '/api/cli')).status, 200);
});

test('cross-origin reads, writes, forms and headerless mutations are rejected', async t => {
  const { origin } = await setup(t);
  assert.equal((await fetch(origin + '/api/state', { headers: { Origin: 'https://evil.invalid' } })).status, 403);
  assert.equal((await fetch(origin + '/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await fetch(origin + '/api/save', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'text/plain', 'X-Studio-Request': '1' }, body: '{}' })).status, 403);
});

test('DNS rebinding Host headers are rejected', async t => {
  const { origin } = await setup(t);
  const code = await new Promise((resolve, reject) => {
    http.get(origin + '/api/state', { headers: { Host: 'evil.invalid' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(code, 403);
});

test('same-origin HTTP save + preview + restore are complete', async t => {
  const { origin } = await setup(t);
  const post = async (endpoint, data) => {
    const response = await fetch(origin + '/api/' + endpoint, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Studio-Request': '1' }, body: JSON.stringify(data) });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  let state = await (await fetch(origin + '/api/state')).json();
  state = await post('save', { revision: state.revision, title: 'HTTP change', edits: [{ type: 'text', file: 'rules/local.md', text: 'Changed' }] });
  const baseline = state.history.find(e => e.kind === 'baseline');
  const preview = await post('preview', { revision: state.revision, id: baseline.id });
  assert.deepEqual(preview.changed, ['rules/local.md']);
  state = await post('restore', { revision: state.revision, id: baseline.id });
  assert.equal(state.history[0].kind, 'restore');
});
