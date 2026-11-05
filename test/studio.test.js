import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Studio } from '../lib/studio.js';
import { capture, fingerprint, applySnapshot } from '../lib/files.js';
import { jsonc, markdown, mask, unmask, validateAgent } from '../lib/config.js';
import { fixture } from './fixture.js';

function setup(t) {
  const f = fixture();
  const studio = new Studio(f.root, f.history, { home: f.directory });
  t.after(() => { studio.close(); f.cleanup(); });
  return { ...f, studio };
}
function saveAgent(studio, id = 'assistant', update = {}) {
  const state = studio.state();
  const agent = state.agents.find(a => a.id === id);
  return studio.save({ revision: state.revision, title: `Update ${id}`, edits: [{ type: 'agent', id, settings: agent.editableSettings, prompt: 'New prompt\n', ...update }] });
}

test('read-only inventory discovers custom, built-in and hidden agents without touching config', t => {
  const { studio, root } = setup(t);
  const before = fingerprint(capture(root));
  const state = studio.state();
  assert.equal(fingerprint(capture(root)), before);
  assert.ok(state.agents.find(a => a.id === 'general').builtin);
  assert.ok(state.agents.find(a => a.id === 'hidden').settings.hidden);
  assert.ok(state.agents.find(a => a.id === 'assistant').legacy);
  assert.ok(state.models.includes('example/coder#high'));
  assert.equal(state.history.length, 0);
  assert.ok(!state.files.some(f => /auth.json|\.env|node_modules/.test(f.name)));
});

test('credentials are masked, environment references are not resolved', t => {
  const { studio } = setup(t);
  const state = JSON.stringify(studio.state());
  assert.ok(!state.includes('fixture-secret-value'));
  assert.ok(!state.includes('fixture-bearer-value'));
  assert.ok(state.includes('секрет сохранён'));
  assert.equal(mask({ apiKey: '{env:MY_KEY}' }).apiKey, '{env:MY_KEY}');
  assert.notEqual(mask({ env: { MY_TOKEN: 'private' } }).env.MY_TOKEN, 'private');
  assert.throws(() => unmask({ apiKey: '⟪секрет сохранён на сервере⟫' }, {}));
});

test('Markdown save migrates V1 permissions to V2, keeps comments and records history', t => {
  const { studio, read } = setup(t);
  const state = saveAgent(studio);
  const content = read('agents/assistant.md');
  assert.ok(content.includes('# Keep YAML comment.'));
  assert.ok(!content.includes('permission:'));
  assert.ok(content.includes('permissions:'));
  assert.deepEqual(markdown(content).settings.permissions, [{ action: 'subagent', resource: '*', effect: 'deny' }]);
  assert.equal(markdown(content).prompt, 'New prompt\n');
  assert.equal(state.history.length, 2);
  assert.equal(state.history[1].kind, 'baseline');
});

test('create nested V2 agent and full rollback remove its file and new directories', t => {
  const { studio, root } = setup(t);
  const before = fingerprint(capture(root));
  let state = studio.state();
  state = studio.save({ revision: state.revision, title: 'New agent', edits: [{ type: 'agent', id: 'team/writer', create: true, settings: { mode: 'subagent', permissions: [{ action: 'edit', resource: '*', effect: 'deny' }] }, prompt: 'Write carefully.' }] });
  assert.ok(fs.existsSync(path.join(root, 'agents/team/writer.md')));
  const baseline = state.history.find(e => e.kind === 'baseline');
  const preview = studio.preview({ revision: state.revision, id: baseline.id });
  assert.ok(preview.changed.includes('agents/team/writer.md'));
  state = studio.restore({ revision: state.revision, id: baseline.id });
  assert.equal(fingerprint(capture(root)), before);
  assert.equal(state.history[0].kind, 'restore');
  assert.equal(state.history.length, 3);
});

test('built-in edits create a user override without modifying OpenCode itself', t => {
  const { studio, read } = setup(t);
  saveAgent(studio, 'explore', { settings: { mode: 'subagent', steps: 12, permissions: [] } });
  assert.equal(markdown(read('agents/explore.md')).settings.steps, undefined);
});

test('JSONC agent edits preserve unrelated root comments', t => {
  const { studio, read } = setup(t);
  saveAgent(studio, 'build');
  assert.ok(read('opencode.jsonc').includes('// Keep this comment.'));
  assert.equal(jsonc(read('opencode.jsonc')).agents.build.system, 'New prompt\n');
});

test('full configuration edit retains masked credentials and unrelated fields', t => {
  const { studio, read } = setup(t);
  const state = studio.state();
  const config = state.configs[0];
  config.value.default_agent = 'plan';
  studio.save({ revision: state.revision, title: 'Default', edits: [{ type: 'config', file: config.name, value: config.value }] });
  const saved = jsonc(read(config.name));
  assert.equal(saved.providers.example.settings.apiKey, 'fixture-secret-value');
  assert.equal(saved.default_agent, 'plan');
  assert.ok(read(config.name).includes('// Keep this comment.'));
});

test('model options are written at provider/model scope, not ineffective agent request scope', t => {
  const { studio, read } = setup(t);
  const state = studio.state();
  studio.save({ revision: state.revision, title: 'Model', edits: [{ type: 'model', model: 'example/coder', value: { settings: { reasoningEffort: 'high' }, body: { temperature: 0.3 } } }] });
  const config = jsonc(read('opencode.jsonc'));
  assert.equal(config.providers.example.models.coder.settings.reasoningEffort, 'high');
  assert.equal(config.providers.example.models.coder.body.temperature, 0.3);
});

test('external edits conflict and do not overwrite user changes', t => {
  const { studio, put, read } = setup(t);
  const state = studio.state();
  put('rules/local.md', 'External changes\n');
  assert.throws(() => studio.save({ revision: state.revision, title: 'Conflict', edits: [{ type: 'text', file: 'rules/local.md', text: 'Lost' }] }), /изменилась/);
  assert.equal(read('rules/local.md'), 'External changes\n');
  assert.equal(studio.state().history.length, 0);
});

test('external changes between saves are captured and can be restored', t => {
  const { studio, put } = setup(t);
  saveAgent(studio);
  put('rules/local.md', 'External changes\n');
  const state = saveAgent(studio, 'assistant', { prompt: 'Third prompt' });
  assert.equal(state.history[1].kind, 'external');
  assert.ok(state.history[1].changed.includes('rules/local.md'));
});

test('all edits validate before any configuration write', t => {
  const { studio, root } = setup(t);
  const state = studio.state();
  const before = fingerprint(capture(root));
  assert.throws(() => studio.save({ revision: state.revision, title: 'Invalid', edits: [{ type: 'text', file: 'rules/local.md', text: 'Changed' }, { type: 'agent', id: 'bad', settings: { mode: 'invalid' }, prompt: 'Bad' }] }), /mode/);
  assert.equal(fingerprint(capture(root)), before);
  assert.equal(studio.state().history.length, 0);
});

test('symlinks are captured without following or editing their external targets', t => {
  const { studio, directory, root } = setup(t);
  const external = path.join(directory, 'outside');
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, 'rule.md'), 'External target');
  fs.symlinkSync(external, path.join(root, 'rules/linked'));
  const files = capture(root);
  assert.equal(files['rules/linked'].type, 'link');
  assert.ok(!files['rules/linked/rule.md']);
  assert.throws(() => studio.readFile('rules/linked/rule.md'), /симлинк/);
  assert.throws(() => studio.readFile('../outside/rule.md'), /путь/);
});

test('snapshots are encrypted and history key has private permissions', t => {
  const { studio, history } = setup(t);
  saveAgent(studio);
  for (const name of fs.readdirSync(history).filter(n => n.endsWith('.snapshot'))) {
    const content = fs.readFileSync(path.join(history, name));
    assert.ok(!content.includes(Buffer.from('fixture-secret-value')));
    assert.throws(() => JSON.parse(content.toString()));
  }
  assert.equal(fs.statSync(path.join(history, 'key')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(history).mode & 0o777, 0o700);
});

test('permissions including non-default umask survive save and restore', t => {
  const { studio, root } = setup(t);
  const file = path.join(root, 'agents/assistant.md');
  fs.chmodSync(file, 0o664);
  saveAgent(studio);
  assert.equal(fs.statSync(file).mode & 0o777, 0o664);
});

test('rollback restores rules, commands, plugin sources and symlink identity', t => {
  const { studio, root, put } = setup(t);
  put('plugins/sample/index.js', 'export default {};');
  fs.symlinkSync('local.md', path.join(root, 'rules/alias'));
  const original = capture(root);
  let state = saveAgent(studio);
  put('rules/local.md', 'Changed externally');
  fs.unlinkSync(path.join(root, 'commands/check.md'));
  put('plugins/sample/index.js', 'Changed plugin');
  fs.unlinkSync(path.join(root, 'rules/alias'));
  fs.symlinkSync('missing.md', path.join(root, 'rules/alias'));
  state = studio.state();
  studio.restore({ revision: state.revision, id: state.history.find(e => e.kind === 'baseline').id });
  assert.equal(fingerprint(capture(root)), fingerprint(original));
});

test('history cannot be opened by two Studio processes or used with another root', t => {
  const { studio, root, history, directory } = setup(t);
  assert.throws(() => new Studio(root, history, { home: directory }), /другом Studio/);
  studio.close();
  const other = path.join(directory, 'other');
  fs.mkdirSync(other);
  assert.throws(() => new Studio(other, history, { home: directory }), /другой конфигурации/);
});

test('unfinished transaction journal restores pre-save state on recovery', t => {
  const { studio, root, put } = setup(t);
  const before = capture(root);
  put('rules/local.md', 'Partial transaction');
  const after = capture(root);
  studio.history.write('pending', { before, event: studio.history.event(after, 'Interrupted', 'save', ['rules/local.md']) });
  studio.history.recover();
  assert.equal(fingerprint(capture(root)), fingerprint(before));
});

test('committed transaction journal recovers forward instead of undoing a recorded commit', t => {
  const { studio, root, put } = setup(t);
  const before = capture(root);
  put('rules/local.md', 'Committed');
  const after = capture(root);
  const event = studio.history.event(after, 'Committed', 'save', ['rules/local.md']);
  studio.history.write('pending', { before, event });
  studio.history.write(`${event.id}.snapshot`, event);
  applySnapshot(root, after, before);
  studio.history.recover();
  assert.equal(fingerprint(capture(root)), fingerprint(after));
});

test('validation rejects mixed V1/V2 and malformed permission rules', () => {
  assert.throws(() => validateAgent({ permission: { edit: 'deny' }, permissions: [] }, true), /смешивайте/);
  assert.throws(() => validateAgent({ permissions: [{ action: 'edit', effect: 'yes' }] }), /Правило/);
  assert.throws(() => validateAgent({ temperature: 0.1 }), /V2/);
  validateAgent({ model: 'example/coder#high', permissions: [], steps: 4 });
});

test('a no-op restore does not fabricate a new snapshot', t => {
  const { studio } = setup(t);
  const state = saveAgent(studio);
  const restored = studio.restore({ revision: state.revision, id: state.history[0].id });
  assert.equal(restored.history.length, state.history.length);
});

test('editing the last layer does not copy inherited settings into it', t => {
  const { studio, put, read } = setup(t);
  put('opencode.json', '{"agents":{"assistant":{"description":"Inherited","steps":9}}}');
  const agent = studio.state().agents.find(a => a.id === 'assistant');
  assert.equal(agent.settings.steps, 9);
  assert.equal(agent.editableSettings.steps, undefined);
  saveAgent(studio);
  assert.equal(markdown(read('agents/assistant.md')).settings.steps, undefined);
});
