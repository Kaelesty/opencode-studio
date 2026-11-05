import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Studio } from '../lib/studio.js';
import { jsonc, markdown } from '../lib/config.js';
import { migrateAgent } from '../lib/migrate.js';
import { fixture } from './fixture.js';

function setup(t) {
  const f = fixture();
  const studio = new Studio(f.root, f.history, { home: f.directory });
  t.after(() => { studio.close(); f.cleanup(); });
  const save = edits => studio.save({ revision: studio.state().revision, title: 'Feature test', edits });
  return { ...f, studio, save };
}

test('V1 agent migration converts ordered access rules, model variants and removes step limits', () => {
  const result = migrateAgent({ model: 'example/coder', variant: 'high', permission: { bash: { '*': 'ask', 'git status': 'allow' }, task: 'deny' }, tools: { websearch: false }, disable: false, reasoningEffort: 'high', maxSteps: 20 });
  assert.deepEqual(result.settings, { model: 'example/coder#high', permissions: [{ action: 'shell', resource: '*', effect: 'ask' }, { action: 'shell', resource: 'git status', effect: 'allow' }, { action: 'subagent', resource: '*', effect: 'deny' }, { action: 'websearch', resource: '*', effect: 'deny' }], disabled: false });
  assert.deepEqual(result.removed, ['reasoningEffort']);
});

test('editing an inline legacy agent writes only a native V2 entry', t => {
  const { studio, put, save, read } = setup(t);
  put('opencode.json', '{"agent":{"review":{"model":"example/coder","variant":"high","permission":{"edit":"deny"},"maxSteps":5}}}');
  const agent = studio.state().agents.find(a => a.id === 'review');
  save([{ type: 'agent', id: 'review', settings: agent.v2Settings, prompt: 'Review prompt' }]);
  const config = jsonc(read('opencode.json'));
  assert.equal(config.agent.review, undefined);
  assert.equal(config.agents.review.model, 'example/coder#high');
  assert.equal(config.agents.review.system, 'Review prompt');
  assert.equal(config.agents.review.maxSteps, undefined);
});

test('copying an agent preserves masked settings server-side without changing the source', t => {
  const { studio, put, save, read } = setup(t);
  put('agents/template.md', '---\nmode: subagent\nrequest:\n  apiKey: fixture-template-secret\n---\nTemplate prompt\n');
  const original = read('agents/template.md');
  const template = studio.state().agents.find(a => a.id === 'template');
  assert.notEqual(template.v2Settings.request.apiKey, 'fixture-template-secret');
  save([{ type: 'agent', id: 'template-copy', create: true, copyFrom: 'template', settings: template.v2Settings, prompt: template.prompt }]);
  const copy = markdown(read('agents/template-copy.md'));
  assert.equal(copy.settings.request.apiKey, 'fixture-template-secret');
  assert.equal(copy.settings.mode, 'subagent');
  assert.equal(copy.prompt, template.prompt);
  assert.equal(read('agents/template.md'), original);
});

test('agent copying rejects missing templates and existing destinations without writes', t => {
  const { studio, save } = setup(t);
  const before = studio.state().revision;
  assert.throws(() => save([{ type: 'agent', id: 'copy', create: true, copyFrom: 'missing', settings: {}, prompt: '' }]), /шаблон/);
  assert.throws(() => save([{ type: 'agent', id: 'assistant', create: true, copyFrom: 'plan', settings: {}, prompt: '' }]), /уже существует/);
  assert.throws(() => save([{ type: 'agent', id: 'assistant', copyFrom: 'plan', settings: {}, prompt: '' }]), /нового агента/);
  assert.equal(studio.state().revision, before);
});

test('model picker patches migrate the selected legacy provider, retaining credentials and other models', t => {
  const { put, save, read } = setup(t);
  put('opencode.json', JSON.stringify({ provider: { old: { npm: '@ai-sdk/openai-compatible', options: { apiKey: 'fixture-provider-key', baseURL: 'https://example.invalid' }, models: { coder: { name: 'Coder', limit: { context: 65536, output: 4096 }, options: { reasoningEffort: 'medium' }, tool_call: true, modalities: { input: ['text'], output: ['text'] }, cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 }, variants: { high: { reasoningEffort: 'high' } } }, other: { name: 'Other' } } } } }));
  save([{ type: 'model', model: 'old/coder', patch: { 'limit.context': 262144 } }]);
  const config = jsonc(read('opencode.json'));
  assert.equal(config.provider.old, undefined);
  const provider = config.providers.old;
  assert.equal(provider.package, 'aisdk:@ai-sdk/openai-compatible');
  assert.equal(provider.settings.apiKey, 'fixture-provider-key');
  assert.equal(provider.models.coder.limit.context, 262144);
  assert.equal(provider.models.coder.settings.reasoningEffort, 'medium');
  assert.deepEqual(provider.models.coder.variants, [{ id: 'high', settings: { reasoningEffort: 'high' } }]);
  assert.equal(provider.models.other.name, 'Other');
  assert.equal(provider.models.coder.cost.cache.read, 0.1);
});

test('model limit pickers reject invalid and unknown patches without writing', t => {
  const { studio, save } = setup(t);
  const before = studio.state().revision;
  assert.throws(() => save([{ type: 'model', model: 'example/coder', patch: { 'limit.context': -1 } }]), /положительным/);
  assert.throws(() => save([{ type: 'model', model: 'example/coder', patch: { 'settings.apiKey': 'bad' } }]), /Недопустимый/);
  assert.equal(studio.state().revision, before);
});

test('build and plan can be deleted through native disabled overrides and recovered', t => {
  const { studio, save, read } = setup(t);
  let state = save([{ type: 'delete-agent', id: 'build' }, { type: 'delete-agent', id: 'plan' }]);
  const config = jsonc(read('opencode.jsonc'));
  assert.equal(config.agents.build.disabled, true);
  assert.equal(config.agents.plan.disabled, true);
  assert.ok(state.agents.filter(a => !a.settings.disabled).every(a => !['build', 'plan'].includes(a.id)));
  state = studio.restore({ revision: state.revision, id: state.history.find(e => e.kind === 'baseline').id });
  assert.ok(state.agents.find(a => a.id === 'plan' && !a.settings.disabled));
});

test('deleting a custom agent removes all its definitions and updates default_agent', t => {
  const { studio, put, save, read, root } = setup(t);
  put('opencode.json', '{"agent":{"assistant":{"description":"Lower layer"}}}');
  save([{ type: 'delete-agent', id: 'assistant' }]);
  assert.ok(!fs.existsSync(path.join(root, 'agents/assistant.md')));
  assert.equal(jsonc(read('opencode.json')).agent.assistant, undefined);
  assert.notEqual(jsonc(read('opencode.jsonc')).default_agent, 'assistant');
  assert.ok(!studio.state().agents.some(a => a.id === 'assistant'));
});

test('ordinary local skill prompt editing preserves its frontmatter and can be rolled back', t => {
  const { studio, put, save, read } = setup(t);
  put('skills/local/SKILL.md', '---\nname: Local Skill\ndescription: Keep metadata\n---\nOriginal prompt\n');
  const doc = studio.state().documents.find(d => d.kind === 'skill');
  assert.equal(doc.readonly, false);
  assert.equal(studio.document(doc.id).prompt, 'Original prompt\n');
  let state = save([{ type: 'document', id: doc.id, prompt: 'Tuned prompt\n' }]);
  assert.equal(markdown(read('skills/local/SKILL.md')).settings.description, 'Keep metadata');
  assert.equal(markdown(read('skills/local/SKILL.md')).prompt, 'Tuned prompt\n');
  studio.restore({ revision: state.revision, id: state.history.find(e => e.kind === 'baseline').id });
  assert.equal(markdown(read('skills/local/SKILL.md')).prompt, 'Original prompt\n');
});

test('symlink skills and rules can be read but never written, including directory links', t => {
  const { studio, put, save, root, directory } = setup(t);
  const outside = path.join(directory, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'SKILL.md'), '---\nname: Linked Skill\n---\nLinked prompt\n');
  fs.symlinkSync(outside, path.join(root, 'skills'));
  put('rules/normal.md', 'Rule body');
  fs.symlinkSync('normal.md', path.join(root, 'rules/link.md'));
  const docs = studio.state().documents;
  const skill = docs.find(d => d.kind === 'skill');
  assert.equal(skill.readonly, true);
  assert.equal(studio.document(skill.id).prompt, 'Linked prompt\n');
  assert.throws(() => save([{ type: 'document', id: skill.id, prompt: 'Changed' }]), /readonly/);
  assert.equal(docs.find(d => d.source === 'rules/link.md').readonly, true);
});

test('external non-symlink skills are editable, encrypted in snapshots, and restorable after reopening', t => {
  const { studio, directory, root, history, save } = setup(t);
  const skill = path.join(directory, '.agents/skills/external/SKILL.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, '---\nname: External\n---\nExternal original\n');
  const doc = studio.state().documents.find(d => d.name === 'External');
  assert.equal(doc.readonly, false);
  let state = save([{ type: 'document', id: doc.id, prompt: 'External tuned\n' }]);
  const baseline = state.history.find(e => e.kind === 'baseline').id;
  studio.close();
  const reopened = new Studio(root, history, { home: directory });
  try {
    state = reopened.state();
    reopened.restore({ revision: state.revision, id: baseline });
    assert.equal(markdown(fs.readFileSync(skill, 'utf8')).prompt, 'External original\n');
    assert.ok(!JSON.stringify(reopened.state()).includes(skill));
  } finally { reopened.close(); }
});

test('external skill changes conflict with a stale draft', t => {
  const { studio, directory } = setup(t);
  const skill = path.join(directory, '.agents/skills/local.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, 'Original');
  const state = studio.state();
  const doc = state.documents.find(d => d.kind === 'skill');
  fs.writeFileSync(skill, 'External edit');
  assert.throws(() => studio.save({ revision: state.revision, title: 'Stale', edits: [{ type: 'document', id: doc.id, prompt: 'Lost update' }] }), /изменилась/);
});

test('replacing a tracked external skill with a symlink blocks restoring it', t => {
  const { studio, directory, save } = setup(t);
  const skill = path.join(directory, '.agents/skills/local.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, 'Original');
  const doc = studio.state().documents.find(d => d.kind === 'skill');
  let state = save([{ type: 'document', id: doc.id, prompt: 'Changed' }]);
  const baseline = state.history.find(e => e.kind === 'baseline').id;
  const target = path.join(directory, 'target.md');
  fs.writeFileSync(target, 'Do not overwrite');
  fs.unlinkSync(skill);
  fs.symlinkSync(target, skill);
  state = studio.state();
  assert.throws(() => studio.restore({ revision: state.revision, id: baseline }), /readonly/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'Do not overwrite');
});

test('runtime-only skills are visible but readonly and document IDs cannot select arbitrary paths', t => {
  const { studio, save } = setup(t);
  const result = studio.inventory({ models: [], skills: [{ id: 'builtin', name: 'Builtin skill', description: 'From API', path: '/builtin/test.md', prompt: 'Builtin prompt' }] });
  const doc = result.documents.find(d => d.skillId === 'builtin');
  assert.equal(studio.document(doc.id).prompt, 'Builtin prompt');
  assert.throws(() => save([{ type: 'document', id: doc.id, prompt: 'Bad' }]), /readonly/);
  assert.throws(() => studio.document('../../secret'), /не найдена/);
});

test('base AGENTS.md and rules share the document editor and storyline', t => {
  const { studio, put, save, read } = setup(t);
  put('AGENTS.md', 'Base rules');
  const base = studio.state().documents.find(d => d.kind === 'base');
  save([{ type: 'document', id: base.id, prompt: 'Tuned base rules' }]);
  assert.equal(read('AGENTS.md'), 'Tuned base rules');
  assert.ok(studio.state().history[0].changed.includes('AGENTS.md'));
});

test('recovering an old journal never deletes newly enrolled external skill files', t => {
  const { studio, directory, root, history } = setup(t);
  const before = studio.history.capture();
  const event = studio.history.event(before, 'Old pending journal', 'save', []);
  studio.history.write('pending', { before, event });
  studio.close();
  const skill = path.join(directory, '.agents/skills/new.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, 'New external skill');
  const reopened = new Studio(root, history, { home: directory });
  try { assert.equal(fs.readFileSync(skill, 'utf8'), 'New external skill'); }
  finally { reopened.close(); }
});

test('interrupted external skill edits recover their original prompt on startup', t => {
  const { studio, directory, root, history } = setup(t);
  const skill = path.join(directory, '.agents/skills/local.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, 'Original external skill');
  const state = studio.state();
  const doc = state.documents.find(d => d.kind === 'skill');
  const before = studio.history.capture();
  const after = structuredClone(before);
  after[doc.historyKey].data = Buffer.from('Partial change').toString('base64');
  studio.history.write('pending', { before, event: studio.history.event(after, 'Interrupted', 'save', [doc.historyKey]) });
  fs.writeFileSync(skill, 'Partial change');
  studio.close();
  const reopened = new Studio(root, history, { home: directory });
  try { assert.equal(fs.readFileSync(skill, 'utf8'), 'Original external skill'); }
  finally { reopened.close(); }
});

test('agent model edits are restricted to available models and variants from OpenCode', t => {
  const { studio, save } = setup(t);
  studio.inventory({ models: [{ ref: 'example/coder', enabled: true, variants: ['high'] }], skills: [] });
  assert.throws(() => save([{ type: 'agent', id: 'assistant', settings: { model: 'unknown/model' }, prompt: 'Prompt' }]), /доступную модель/);
  assert.throws(() => save([{ type: 'agent', id: 'assistant', settings: { model: 'example/coder#fake' }, prompt: 'Prompt' }]), /доступную модель/);
  save([{ type: 'agent', id: 'assistant', settings: { model: 'example/coder#high' }, prompt: 'Prompt' }]);
});
