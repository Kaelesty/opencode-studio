import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Studio } from '../lib/studio.js';
import { jsonc, markdown } from '../lib/config.js';
import { compileRequiredRules, REQUIRED_PLUGIN, REQUIRED_DIRECTORY } from '../lib/required-skills.js';
import plugin from '../runtime/required-skills.js';
import { fixture } from './fixture.js';

const force = { action: 'skill', resource: 'ponytail', effect: 'force' };
const deny = { action: 'skill', resource: '*', effect: 'deny' };
function setup(t) {
  const f = fixture();
  f.put('skills/ponytail/SKILL.md', '---\nname: Ponytail\ndescription: Small complete changes\n---\nSYNTHETIC_SKILL_BODY\n');
  const studio = new Studio(f.root, f.history, { home: f.directory });
  t.after(() => { studio.close(); f.cleanup(); });
  const save = (rules, id = 'assistant', extras = {}) => {
    const state = studio.state();
    const agent = state.agents.find(a => a.id === id);
    return studio.save({ revision: state.revision, title: 'Required skill', edits: [{ type: 'agent', id, settings: { ...agent.v2Settings, permissions: rules }, prompt: agent.prompt, ...extras }] });
  };
  const options = () => jsonc(f.read('opencode.jsonc')).plugins?.find(p => p.package === REQUIRED_PLUGIN)?.options;
  return { ...f, studio, save, options };
}

test('force compiles to native allow plus explicit required skills, honoring last-match order', () => {
  assert.deepEqual(compileRequiredRules([deny, force]), { permissions: [deny, { ...force, effect: 'allow' }], skills: ['ponytail'] });
  assert.deepEqual(compileRequiredRules([force, deny]).skills, []);
  assert.deepEqual(compileRequiredRules([force, { action: '*', resource: '*', effect: 'ask' }]).skills, []);
  assert.deepEqual(compileRequiredRules([force, force]).skills, ['ponytail']);
  assert.throws(() => compileRequiredRules([{ ...force, action: 'shell' }]), /только конкретный скилл/);
  assert.throws(() => compileRequiredRules([{ ...force, resource: '*' }]), /без wildcard/);
});

test('required skill save is valid native V2 and retains force in Studio metadata', t => {
  const { studio, save, read, options, root } = setup(t);
  assert.ok(!fs.existsSync(path.join(root, REQUIRED_DIRECTORY)));
  const state = save([deny, force]);
  assert.equal(markdown(read('agents/assistant.md')).settings.permissions[1].effect, 'allow');
  assert.deepEqual(options().agents.assistant.skills, ['ponytail']);
  assert.equal(options().agents.assistant.rules[1].effect, 'force');
  assert.ok(fs.existsSync(path.join(root, REQUIRED_DIRECTORY, 'index.js')));
  const agent = state.agents.find(a => a.id === 'assistant');
  assert.equal(agent.v2Settings.permissions[1].effect, 'force');
  assert.equal(agent.forceConflict, false);
  assert.equal(studio.state().history.length, 2);
});

test('inactive force rules retain their intent and activate when reordered', t => {
  const { save, options } = setup(t);
  save([force, deny]);
  assert.deepEqual(options().agents.assistant.skills, []);
  assert.equal(options().agents.assistant.rules[0].effect, 'force');
  save([deny, force]);
  assert.deepEqual(options().agents.assistant.skills, ['ponytail']);
});

test('last required rule removal cleans up only the managed plugin and preserves other plugins', t => {
  const { save, put, read, options, root } = setup(t);
  const config = jsonc(read('opencode.jsonc'));
  config.plugins = ['unrelated-plugin'];
  put('opencode.jsonc', JSON.stringify(config));
  save([force]);
  save([{ ...force, effect: 'ask' }]);
  assert.equal(options(), undefined);
  assert.deepEqual(jsonc(read('opencode.jsonc')).plugins, ['unrelated-plugin']);
  assert.ok(!fs.existsSync(path.join(root, REQUIRED_DIRECTORY, 'index.js')));
  assert.equal(markdown(read('agents/assistant.md')).settings.permissions[0].effect, 'ask');
});

test('deleting a forced agent preserves requirements of other agents', t => {
  const { studio, save, options } = setup(t);
  save([force]);
  save([force], 'ensemble');
  studio.save({ revision: studio.state().revision, title: 'Delete assistant', edits: [{ type: 'delete-agent', id: 'assistant' }] });
  assert.equal(options().agents.assistant, undefined);
  assert.deepEqual(options().agents.ensemble.skills, ['ponytail']);
});

test('required-skill configuration and generated plugin participate in full rollback', t => {
  const { studio, save, root, options } = setup(t);
  const state = save([force]);
  studio.restore({ revision: state.revision, id: state.history.find(e => e.kind === 'baseline').id });
  assert.equal(options(), undefined);
  assert.ok(!fs.existsSync(path.join(root, REQUIRED_DIRECTORY)));
  assert.ok(!markdown(fs.readFileSync(path.join(root, 'agents/assistant.md'), 'utf8')).settings.permissions);
});

test('missing skills, wildcard targets and maintenance agents are rejected without writes', t => {
  const { studio, save } = setup(t);
  const before = studio.state().revision;
  assert.throws(() => save([{ ...force, resource: 'missing-skill' }]), /отсутствует в каталоге/);
  assert.throws(() => save([{ ...force, resource: '*' }]), /wildcard/);
  assert.throws(() => save([force], 'title'), /служебных/);
  assert.equal(studio.state().revision, before);
});

test('foreign plugin files are never overwritten', t => {
  const { studio, put, save, read } = setup(t);
  put(`${REQUIRED_DIRECTORY}/index.js`, 'Foreign code');
  const before = studio.state().revision;
  assert.throws(() => save([force]), /чужими файлами/);
  assert.equal(read(`${REQUIRED_DIRECTORY}/index.js`), 'Foreign code');
  assert.equal(studio.state().revision, before);
});

test('independent permission edits require an explicit force reset, without granting access', t => {
  const { studio, save, put, read, options } = setup(t);
  save([force]);
  const content = markdown(read('agents/assistant.md'));
  content.settings.permissions = [deny];
  put('agents/assistant.md', '---\n' + 'permissions:\n  - action: skill\n    resource: "*"\n    effect: deny\n---\n' + content.prompt);
  assert.equal(studio.state().agents.find(a => a.id === 'assistant').forceConflict, true);
  assert.throws(() => save([deny]), /вне Studio/);
  save([deny], 'assistant', { resetRequiredSkills: true });
  assert.equal(options(), undefined);
  assert.deepEqual(markdown(read('agents/assistant.md')).settings.permissions, [deny]);
});

test('runtime hook loads current skill instructions on every primary model request', async () => {
  let hook, disposed = false, content = 'SYNTHETIC_SKILL_BODY';
  const permissions = [];
  const cleanup = await plugin.setup({
    options: { agents: { assistant: { skills: ['ponytail'] } } },
    session: { hook: async (name, callback) => { assert.equal(name, 'context'); hook = callback; return { dispose: async () => { disposed = true; } }; } },
    skill: { list: async () => ({ data: [{ id: 'ponytail', path: path.resolve('test-results/mock/SKILL.md'), content }] }) },
    permission: { assert: async input => { permissions.push(input); } },
  });
  const event = () => ({ sessionID: 'test-session', agent: 'assistant', system: [{ type: 'text', text: 'Original system prompt' }] });
  const first = event();
  await hook(first);
  assert.equal(first.system[0].text, 'Original system prompt');
  assert.ok(first.system[1].text.includes('SYNTHETIC_SKILL_BODY'));
  assert.ok(first.system[1].text.includes('Base directory:'));
  assert.deepEqual(permissions[0], { sessionID: 'test-session', agent: 'assistant', action: 'skill', resources: ['ponytail'], save: ['ponytail'] });
  content = 'UPDATED_SKILL_BODY';
  const second = event();
  await hook(second);
  assert.ok(second.system[1].text.includes('UPDATED_SKILL_BODY'));
  assert.equal(second.system.length, 2);
  const other = { ...event(), agent: 'build' };
  await hook(other);
  assert.equal(other.system.length, 1);
  await cleanup();
  assert.equal(disposed, true);
});

test('runtime hook propagates native permission denials and never injects denied content', async () => {
  let hook;
  await plugin.setup({
    options: { agents: { assistant: { skills: ['ponytail'] } } },
    session: { hook: async (_name, callback) => { hook = callback; return { dispose() {} }; } },
    skill: { list: async () => ({ data: [{ id: 'ponytail', content: 'DENIED_BODY' }] }) },
    permission: { assert: async () => { throw new Error('Blocked by configuration policy'); } },
  });
  const event = { sessionID: 'test-session', agent: 'assistant', system: [] };
  await assert.rejects(hook(event), /Blocked by configuration policy/);
  assert.equal(event.system.length, 0);
});
