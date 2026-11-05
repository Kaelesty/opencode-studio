import { parse, modify, applyEdits } from 'jsonc-parser';
import YAML from 'yaml';
import { migrateAgent } from './migrate.js';
import { requiredProfiles, requiredView } from './required-skills.js';

export const MAIN_AGENTS = ['assistant', 'ensemble', 'stable-duty', 'build', 'plan'];
export const BUILTINS = {
  build: { mode: 'primary', description: 'Встроенный агент для разработки' },
  plan: { mode: 'primary', description: 'Планирование и исследование' },
  general: { mode: 'subagent', description: 'Универсальный подагент' },
  explore: { mode: 'subagent', description: 'Поиск и чтение без редактирования' },
  compaction: { hidden: true, description: 'Сжатие контекста' },
  title: { hidden: true, description: 'Заголовки сессий' },
  summary: { hidden: true, description: 'Сводки сессий' },
};

export function object(value, label = 'Настройки') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: ожидается объект`);
  return value;
}

export function jsonc(text) {
  const errors = [];
  const value = parse(text, errors, { allowTrailingComma: true });
  if (errors.length) throw new Error(`Ошибка JSONC около символа ${errors[0].offset}`);
  return object(value);
}

export function markdown(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) return { settings: {}, prompt: text };
  const doc = YAML.parseDocument(match[1]);
  if (doc.errors.length) throw new Error('Ошибка YAML frontmatter');
  return { settings: object(doc.toJS() ?? {}, 'Frontmatter'), prompt: match[2] };
}

export function legacy(settings, fallback = false) {
  if (['permissions', 'request', 'system', 'disabled'].some(k => k in settings)) return false;
  return fallback || ['permission', 'prompt', 'disable', 'variant', 'tools', 'temperature', 'reasoningEffort', 'maxSteps', 'options'].some(k => k in settings);
}

export function validateAgent(settings, old = false) {
  object(settings);
  if (settings.mode !== undefined && !['primary', 'subagent', 'all'].includes(settings.mode)) throw new Error('mode: primary, subagent или all');
  for (const key of ['description', 'color', old ? 'prompt' : 'system']) {
    if (key in settings && typeof settings[key] !== 'string') throw new Error(`${key}: ожидается строка`);
  }
  if (!old && settings.color !== undefined && !/^#[\da-f]{6}$/i.test(settings.color)) throw new Error('Цвет V2 должен быть шестизначным HEX-значением');
  for (const key of ['hidden', old ? 'disable' : 'disabled']) {
    if (key in settings && typeof settings[key] !== 'boolean') throw new Error(`${key}: ожидается boolean`);
  }
  const steps = settings[old ? 'maxSteps' : 'steps'];
  if (steps !== undefined && (!Number.isInteger(steps) || steps < 1)) throw new Error('Лимит шагов должен быть положительным целым числом');
  if (settings.model !== undefined && typeof settings.model !== 'string') {
    const model = object(settings.model, 'model');
    if (typeof model.providerID !== 'string' || typeof model.model !== 'string') throw new Error('model: нужны providerID и model');
  }
  if (settings.permissions !== undefined) {
    if (!Array.isArray(settings.permissions)) throw new Error('permissions: ожидается массив');
    for (const rule of settings.permissions) {
      object(rule, 'Правило');
      if (typeof rule.action !== 'string' || typeof rule.resource !== 'string' || !['ask', 'allow', 'deny'].includes(rule.effect)) throw new Error('Правило: action, resource и effect (allow/ask/deny)');
    }
  }
  if (old && ['permissions', 'request', 'system', 'disabled'].some(k => k in settings)) throw new Error('Не смешивайте V1 и V2 в одном агенте');
  if (!old && ['permission', 'prompt', 'disable', 'variant', 'tools', 'temperature', 'top_p', 'maxSteps', 'options', 'reasoningEffort'].some(k => k in settings)) throw new Error('Для нового V2-агента используйте model#variant и permissions; параметры запроса задаются у модели');
}

export function validateConfig(value) {
  object(value);
  for (const section of ['agent', 'agents']) {
    if (!value[section]) continue;
    for (const agent of Object.values(object(value[section]))) {
      if (agent !== false) validateAgent(agent, section === 'agent' && legacy(agent, true));
    }
  }
  if (value.permissions !== undefined && !Array.isArray(value.permissions)) throw new Error('permissions: ожидается массив');
  if (value.default_agent !== undefined && typeof value.default_agent !== 'string') throw new Error('default_agent: ожидается строка');
}

export function editJson(text, path, value) {
  return applyEdits(text, modify(text, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
}

export function editMarkdown(original, settings, prompt) {
  const match = original.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const doc = YAML.parseDocument(match?.[1] || '{}');
  if (doc.errors.length) throw new Error('Некорректный YAML');
  const previous = doc.toJS() || {};
  for (const key of Object.keys(previous)) if (!(key in settings)) doc.delete(key);
  for (const [key, value] of Object.entries(settings)) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(value)) doc.set(key, value);
  }
  return `---\n${String(doc).trimEnd()}\n---\n${prompt}`;
}

// Secret values stay on the server. References are safe to edit without resolving them.
const secretKey = /api.?key|secret|password|authorization|cookie|(?:^|[_-])token$|access.?token|refresh.?token|private.?key|credential/i;
const reference = value => typeof value === 'string' && /^\{(?:env|file):[^}]+\}$/.test(value);
export function mask(value, trail = []) {
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (secretKey.test(key) && item && !reference(item)) return [key, '⟪секрет сохранён на сервере⟫'];
    return [key, Array.isArray(item) ? item.map(x => mask(x, [...trail, key])) : mask(item, [...trail, key])];
  }));
}

export function unmask(value, previous) {
  if (value === '⟪секрет сохранён на сервере⟫') {
    if (previous === undefined) throw new Error('Нельзя переносить маркер секрета в новое поле');
    return previous;
  }
  if (Array.isArray(value)) return value.map((x, i) => unmask(x, previous?.[i]));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unmask(v, previous?.[k])]));
  return value;
}

export function catalog(files) {
  const agents = new Map(Object.entries(BUILTINS).map(([id, settings]) => [id, { id, settings, editableSettings: {}, prompt: '', sources: [], builtin: true, legacy: false }]));
  const configs = [];
  const warnings = [];
  const models = new Set();
  const add = (id, settings, prompt, source, old) => {
    const before = agents.get(id);
    agents.set(id, { id, settings: { ...before?.settings, ...settings }, editableSettings: settings, prompt: prompt ?? before?.prompt ?? '', sources: [...before?.sources || [], source], builtin: before?.builtin || false, legacy: old });
  };
  for (const name of ['opencode.json', 'opencode.jsonc']) {
    const file = files[name];
    if (!file || file.type !== 'file') continue;
    try {
      const config = jsonc(Buffer.from(file.data, 'base64').toString());
      configs.push({ name, value: config });
      for (const section of ['mode', 'agent', 'agents']) for (const [id, setting] of Object.entries(config[section] || {})) {
        if (setting === false) continue;
        const old = section !== 'agents' && legacy(setting, true);
        const { [old ? 'prompt' : 'system']: prompt, ...settings } = setting;
        add(id, settings, prompt, { file: name, section }, old);
      }
      for (const providerSection of ['provider', 'providers']) for (const [provider, value] of Object.entries(config[providerSection] || {})) {
        for (const [id, model] of Object.entries(value.models || {})) {
          models.add(`${provider}/${id}`);
          for (const variant of Array.isArray(model.variants) ? model.variants.map(x => x.id) : Object.keys(model.variants || {})) models.add(`${provider}/${id}#${variant}`);
        }
      }
    } catch (error) { warnings.push(`${name}: ${error.message}`); }
  }
  for (const [name, file] of Object.entries(files).sort()) {
    const match = name.match(/^(agent|agents|mode|modes)\/(.+)\.md$/);
    if (!match || file.type !== 'file') continue;
    try {
      const { settings, prompt } = markdown(Buffer.from(file.data, 'base64').toString());
      add(match[2], settings, prompt, { file: name }, legacy(settings));
    } catch (error) { warnings.push(`${name}: ${error.message}`); }
  }
  for (const agent of agents.values()) if (typeof agent.settings.model === 'string') models.add(agent.settings.model);
  const forced = requiredProfiles(configs.map(config => config.value));
  return { agents: [...agents.values()].map(a => {
    const migrated = migrateAgent(a.editableSettings);
    const required = requiredView(migrated.settings, forced[a.id]);
    return { ...a, settings: mask(a.settings), editableSettings: mask(a.editableSettings), v2Settings: mask(required.settings), migrationRemoved: migrated.removed, requiredSkills: required.skills, forceConflict: required.conflict };
  }), configs: configs.map(c => ({ ...c, value: mask(c.value) })), models: [...models].sort(), warnings };
}
