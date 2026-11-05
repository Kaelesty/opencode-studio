import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeAgent, runtimeCatalog } from '../lib/runtime.js';

test('runtime reader uses a fixed read-only CLI endpoint and returns a static system prompt', async () => {
  let command;
  const agent = await runtimeAgent('plan', async args => {
    command = args;
    return JSON.stringify({ data: { id: 'plan', system: 'Built-in prompt', request: { headers: { Authorization: 'private-value' } } } });
  });
  assert.deepEqual(command, ['api', 'get', '/api/agent/plan']);
  assert.equal(agent.prompt, 'Built-in prompt');
  assert.ok(!JSON.stringify(agent).includes('private-value'));
});

test('runtime model catalogue exposes only picker metadata, not provider credentials', async () => {
  const result = await runtimeCatalog(async args => JSON.stringify({ data: args[2] === '/api/model' ? [{ id: 'coder', providerID: 'example', enabled: true, name: 'Coder', settings: { apiKey: 'do-not-expose' }, headers: { Authorization: 'private' }, variants: [{ id: 'high', settings: { reasoningEffort: 'high' } }], limit: { context: 65536 }, capabilities: { tools: true } }] : [] }));
  assert.deepEqual(result.models[0].variants, ['high']);
  assert.deepEqual(result.models[0].efforts, ['high']);
  assert.ok(!JSON.stringify(result).includes('do-not-expose'));
  assert.equal(result.models[0].settings, undefined);
});

test('malformed catalogue errors never include raw API content', async () => {
  await assert.rejects(runtimeCatalog(async () => '{"apiKey":"private-value"'), error => !error.message.includes('private-value'));
});

test('runtime reader rejects arbitrary IDs, error envelopes and absent CLI', async () => {
  await assert.rejects(runtimeAgent('../config'), /встроенных/);
  await assert.rejects(runtimeAgent('plan', async () => '{"error":"failure"}'), /неожиданный/);
  await assert.rejects(runtimeAgent('plan', async () => { throw new Error('internal path and secret'); }), /Не удалось/);
});
