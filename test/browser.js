import assert from 'node:assert/strict';
import fs from 'node:fs';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { Studio } from '../lib/studio.js';
import { createServer } from '../server.js';
import { markdown, jsonc } from '../lib/config.js';
import { fixture } from './fixture.js';

const f = fixture();
f.put('AGENTS.md', '# Base instructions\n');
f.put('skills/editable/SKILL.md', '---\nname: Editable Skill\ndescription: A local skill\n---\nOriginal skill prompt\n');
f.put('skills/ponytail/SKILL.md', '---\nname: Ponytail\ndescription: Small complete changes\n---\nSYNTHETIC_PONYTAIL_INSTRUCTIONS\n');
f.put('agents/assistant.md', f.read('agents/assistant.md').replace('Test assistant', 'Точечные исправления и помощь с кодом.'));
f.put('agents/ensemble.md', f.read('agents/ensemble.md').replace('description: Ensemble', 'description: Команда специализированных агентов для сложных задач.'));
f.put('agents/stable-duty.md', f.read('agents/stable-duty.md').replace('description: Stable duty', 'description: Диагностика, стабильность и контроль изменений.'));
fs.symlinkSync('editable', f.root + '/skills/linked');
const studio = new Studio(f.root, f.history, { home: f.directory });
const server = createServer(studio, async () => ({ prompt: 'Built-in fixture prompt', settings: {} }), async () => ({ models: [
  { ref: 'example/zulu', id: 'zulu', provider: 'example', name: 'Zulu Model', limit: { context: 65536, output: 4096 }, variants: [], capabilities: { tools: true } },
  { ref: 'example/coder', id: 'coder', provider: 'example', name: 'GPT 6.1 Sol', limit: { context: 131072, output: 4096 }, variants: ['high', 'medium'], efforts: ['high', 'medium'], capabilities: { tools: true } },
  { ref: 'example/alpha', id: 'alpha', provider: 'example', name: 'Alpha Model', limit: { context: 32768, output: 4096 }, variants: [], capabilities: { tools: true } },
], skills: [] }));
const screenshots = fileURLToPath(new URL('../test-results/', import.meta.url));
let browser;
let page;
const errors = [];
let checks = 0;
function check(value, message) { assert.ok(value, message); checks++; }

try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  browser = await chromium.launch({ headless: true, channel: process.env.STUDIO_BROWSER_CHANNEL });
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(origin);
  await page.getByRole('heading', { name: 'Твой harness. Твои правила.' }).waitFor();
  check(await page.locator('.agent-card[data-agent]').count() === 5, 'Five primary cards');
  await page.screenshot({ path: screenshots + 'agents-light.png', fullPage: true });
  await page.screenshot({ path: screenshots + 'overview-light.png' });
  await page.getByRole('button', { name: 'Сменить тему' }).click();
  check(await page.locator('html').getAttribute('data-theme') === 'dark', 'Dark mode');
  await page.screenshot({ path: screenshots + 'agents-dark.png', fullPage: true });
  await page.screenshot({ path: screenshots + 'overview-dark.png' });
  await page.getByRole('button', { name: 'Сменить тему' }).click();
  await page.locator('[data-view="models"]').click();
  check(JSON.stringify(await page.locator('.model-row strong').allTextContents()) === JSON.stringify(['Alpha Model', 'GPT 6.1 Sol', 'Zulu Model']), 'Models menu sorted alphabetically');
  await page.screenshot({ path: screenshots + 'models.png' });
  await page.locator('[data-view="agents"]').click();
  await page.getByRole('searchbox', { name: 'Найти агента' }).fill('hidden');
  check(await page.locator('.agent-row').count() === 1, 'Catalog search');
  await page.getByRole('searchbox', { name: 'Найти агента' }).fill('');
  await page.locator('[data-agent="plan"]').click();
  await page.getByRole('tab', { name: 'Промпт', exact: true }).click();
  await page.getByRole('button', { name: 'Посмотреть встроенный промпт через OpenCode' }).click();
  await page.getByRole('textbox', { name: 'Runtime-промпт', exact: true }).waitFor();
  check(await page.getByRole('textbox', { name: 'Runtime-промпт', exact: true }).inputValue() === 'Built-in fixture prompt', 'Built-in prompt preview');
  await page.locator('#editor [data-close="editor"]').first().click();

  await page.locator('[data-agent="assistant"]').click();
  check(await page.locator('[name=steps]').count() === 0, 'Step limit removed from editor');
  await page.getByRole('combobox', { name: 'Цвет в OpenCode', exact: true }).selectOption('#6389bb');
  await page.getByRole('tab', { name: 'Модель', exact: true }).click();
  check(JSON.stringify(await page.locator('[name=model] option').evaluateAll(options => options.map(o => o.value).filter(Boolean))) === JSON.stringify(['example/alpha', 'example/coder', 'example/zulu']), 'Agent model picker sorted alphabetically');
  await page.getByRole('combobox', { name: 'Модель агента', exact: true }).selectOption('example/coder');
  await page.getByRole('combobox', { name: 'Вариант модели', exact: true }).selectOption('high');
  await page.getByRole('tab', { name: 'Доступ', exact: true }).click();
  await page.getByRole('button', { name: '＋ Правило', exact: true }).click();
  await page.locator('[data-rule="1"] [name=action]').selectOption('skill');
  await page.locator('[data-rule="1"] [name=effect]').selectOption('force');
  await page.locator('[data-rule="1"] [name=resource]').selectOption('ponytail');
  await page.screenshot({ path: screenshots + 'permissions.png' });
  await page.getByRole('tab', { name: 'Промпт', exact: true }).click();
  await page.getByRole('textbox', { name: 'Системный промпт', exact: true }).fill('Browser-tested prompt\n');
  await page.screenshot({ path: screenshots + 'agent-editor.png' });
  await page.getByRole('button', { name: 'В черновик' }).click();
  check(markdown(f.read('agents/assistant.md')).prompt === 'Original prompt\n', 'Draft does not change configuration');
  await page.locator('#save').click();
  await page.locator('#save-title').fill('Browser prompt update');
  await page.locator('#confirm-action').click();
  await page.locator('#confirm').waitFor({ state: 'hidden' });
  check(markdown(f.read('agents/assistant.md')).prompt === 'Browser-tested prompt\n', 'Saved prompt reaches disk');
  check(f.read('agents/assistant.md').includes('permissions:'), 'Agent migrated to V2');
  check(markdown(f.read('agents/assistant.md')).settings.model === 'example/coder#high', 'Available model and variant pickers');
  check(markdown(f.read('agents/assistant.md')).settings.color === '#6389bb', 'Color selected from palette');
  check(markdown(f.read('agents/assistant.md')).settings.permissions[1].effect === 'allow', 'Force stored as native allow, not an unsupported effect');
  check(jsonc(f.read('opencode.jsonc')).plugins.find(p => p.package === './local-plugins/studio-required-skills').options.agents.assistant.skills[0] === 'ponytail', 'Force enables managed skill autoload');
  await page.locator('[data-agent="assistant"]').click();
  await page.getByRole('tab', { name: 'Доступ', exact: true }).click();
  check(await page.locator('[data-rule="1"] [name=effect]').inputValue() === 'force', 'Force survives a save/reopen roundtrip');
  await page.locator('#editor [data-close="editor"]').first().click();

  await page.getByRole('button', { name: 'Новый агент', exact: false }).click();
  await page.getByRole('textbox', { name: 'ID агента', exact: true }).fill('intecactor');
  await page.getByRole('textbox', { name: 'Описание', exact: true }).fill('Created in a real browser');
  await page.getByRole('tab', { name: 'Доступ', exact: true }).click();
  await page.getByRole('button', { name: '＋ Правило', exact: true }).click();
  await page.locator('[data-rule="0"] [name=action]').selectOption('edit');
  await page.locator('[data-rule="0"] [name=effect]').selectOption('deny');
  await page.getByRole('button', { name: 'В черновик' }).click();
  check(await page.locator('.agent-card[data-agent="intecactor"]').count() === 1, 'Custom primary agent appears among main cards in draft');
  check(await page.locator('.agent-row[data-agent="intecactor"]').count() === 0, 'Custom primary agent is not duplicated in other agents');
  await page.locator('#save').click();
  await page.locator('#confirm-action').click();
  await page.locator('#confirm').waitFor({ state: 'hidden' });
  check(markdown(f.read('agents/intecactor.md')).settings.permissions[0].effect === 'deny', 'New V2 agent saved');
  await page.reload();
  await page.getByRole('heading', { name: 'Твой harness. Твои правила.' }).waitFor();
  check(await page.locator('.agent-card[data-agent="intecactor"]').count() === 1, 'Saved custom primary agent remains among main cards after reload');
  for (const role of ['subagent', 'all']) {
    await page.locator('[data-agent="intecactor"]').click();
    await page.getByRole('combobox', { name: 'Роль', exact: true }).selectOption(role);
    await page.getByRole('button', { name: 'В черновик' }).click();
    check(await page.locator('.agent-card[data-agent="intecactor"]').count() === (role === 'all' ? 1 : 0), `Main cards follow the ${role} role in draft`);
    check(await page.locator('.agent-row[data-agent="intecactor"]').count() === (role === 'subagent' ? 1 : 0), `Other agents follow the ${role} role in draft`);
    await page.locator('#save').click();
    await page.locator('#confirm-action').click();
    await page.locator('#confirm').waitFor({ state: 'hidden' });
  }

  await page.locator('[data-view="models"]').click();
  await page.locator('[data-model="example/coder"]').click();
  await page.getByRole('combobox', { name: 'Контекстное окно', exact: true }).selectOption('262144');
  await page.getByRole('combobox', { name: 'Reasoning effort', exact: true }).selectOption('high');
  await page.getByRole('button', { name: 'В черновик' }).click();
  await page.locator('#save').click();
  await page.locator('#confirm-action').click();
  await page.locator('#confirm').waitFor({ state: 'hidden' });
  check(jsonc(f.read('opencode.jsonc')).providers.example.models.coder.settings.reasoningEffort === 'high', 'Model parameters saved in model configuration');
  check(jsonc(f.read('opencode.jsonc')).providers.example.models.coder.limit.context === 262144, 'Context window saved');

  await page.locator('[data-view="config"]').click();
  await page.locator('[data-config="opencode.jsonc"]').click();
  const configEditor = page.getByRole('textbox', { name: 'Конфигурация JSON', exact: true });
  const value = JSON.parse(await configEditor.inputValue());
  check(value.providers.example.settings.apiKey !== 'fixture-secret-value', 'Secrets masked in editor');
  value.default_agent = 'plan';
  await configEditor.fill(JSON.stringify(value, null, 2));
  await page.getByRole('button', { name: 'В черновик' }).click();
  await page.locator('#save').click();
  await page.locator('#confirm-action').click();
  await page.locator('#confirm').waitFor({ state: 'hidden' });
  check(jsonc(f.read('opencode.jsonc')).default_agent === 'plan', 'Full configuration saved');
  check(jsonc(f.read('opencode.jsonc')).providers.example.settings.apiKey === 'fixture-secret-value', 'Secrets preserved by config editor');

  await page.locator('[data-view="documents"]').click();
  const localSkill = studio.state().documents.find(d => d.kind === 'skill' && !d.readonly);
  const linkedSkill = studio.state().documents.find(d => d.kind === 'skill' && d.readonly);
  await page.locator(`[data-document="${linkedSkill.id}"]`).click();
  check(await page.locator('#document-prompt').getAttribute('readonly') !== null, 'Symlink skill is readonly');
  check(await page.locator('#editor-submit').isHidden(), 'Readonly skill has no save button');
  await page.locator('#editor [data-close="editor"]').first().click();
  await page.locator(`[data-document="${localSkill.id}"]`).click();
  await page.getByRole('textbox', { name: 'Промпт инструкции', exact: true }).fill('Browser skill prompt\n');
  await page.getByRole('button', { name: 'В черновик' }).click();
  await page.locator('#save').click();
  await page.locator('#confirm-action').click();
  await page.locator('#confirm').waitFor({ state: 'hidden' });
  check(markdown(f.read('skills/editable/SKILL.md')).prompt === 'Browser skill prompt\n', 'Skill prompt tuning');
  check(markdown(f.read('skills/editable/SKILL.md')).settings.name === 'Editable Skill', 'Skill metadata preserved');
  const base = studio.state().documents.find(d => d.kind === 'base');
  await page.locator(`[data-document="${base.id}"]`).click();
  check(await page.getByRole('textbox', { name: 'Промпт инструкции', exact: true }).inputValue() === '# Base instructions\n', 'Base AGENTS.md visible');
  await page.locator('#editor [data-close="editor"]').first().click();
  await page.screenshot({ path: screenshots + 'documents.png', fullPage: true });

  await page.locator('[data-view="agents"]').click();
  for (const id of ['intecactor', 'build', 'plan']) {
    await page.locator(`[data-agent="${id}"]`).click();
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Удалить агента', exact: true }).click();
  }
  await page.locator('#save').click();
  await page.locator('#confirm-action').click();
  await page.locator('#confirm').waitFor({ state: 'hidden' });
  check(!fs.existsSync(f.root + '/agents/intecactor.md'), 'Custom agent deletion');
  check(jsonc(f.read('opencode.jsonc')).agents.build.disabled === true && jsonc(f.read('opencode.jsonc')).agents.plan.disabled === true, 'Built-in build and plan disabled in V2');
  check(await page.locator('[data-agent="build"], [data-agent="plan"]').count() === 0, 'Deleted built-ins removed from UI');

  await page.locator('[data-view="history"]').click();
  await page.screenshot({ path: screenshots + 'history.png', fullPage: true });
  await page.locator('.timeline-event').last().getByRole('button', { name: 'Восстановить' }).click();
  await page.locator('#confirm-action').click();
  await page.locator('#confirm').waitFor({ state: 'hidden' });
  check(markdown(f.read('agents/assistant.md')).prompt === 'Original prompt\n', 'Full rollback restores original prompt');
  check(!fs.existsSync(f.root + '/agents/intecactor.md'), 'Full rollback removes newly created agent');
  check(jsonc(f.read('opencode.jsonc')).default_agent === 'assistant', 'Full rollback restores root configuration');
  check(studio.state().history[0].kind === 'restore', 'Rollback itself is revisioned');
  check(markdown(f.read('skills/editable/SKILL.md')).prompt === 'Original skill prompt\n', 'Full rollback restores skill prompt');

  await page.locator('[data-view="agents"]').click();
  await page.locator('[data-agent="assistant"]').click();
  await page.getByRole('tab', { name: 'Все поля', exact: true }).click();
  await page.getByRole('textbox', { name: 'Все параметры агента JSON', exact: true }).fill('{ broken');
  await page.getByRole('button', { name: 'В черновик' }).click();
  check(await page.locator('#editor-error').isVisible(), 'Invalid JSON is caught in the editor');
  await page.locator('#editor [data-close="editor"]').first().click();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: screenshots + 'agents-mobile.png', fullPage: true });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile page does not overflow');
  await page.locator('[data-agent="assistant"]').click();
  check(await page.evaluate(() => document.querySelector('#editor').scrollWidth <= innerWidth), 'Mobile dialog does not overflow');
  await page.locator('#editor [data-close="editor"]').first().click();
  check(errors.length === 0, 'No browser console errors: ' + errors.join('; '));
  console.log(`Browser checks: ${checks} passed. Screenshots: test-results/*.png (synthetic configuration only).`);
} catch (error) {
  if (page) await page.screenshot({ path: screenshots + 'failure.png', fullPage: true });
  throw error;
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  studio.close();
  f.cleanup();
}
