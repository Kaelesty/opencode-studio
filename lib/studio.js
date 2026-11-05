import fs from 'node:fs';
import path from 'node:path';
import { capture, fingerprint, safePath, EXCLUDED, changes } from './files.js';
import { History } from './history.js';
import { catalog, markdown, jsonc, validateAgent, validateConfig, object, editJson, editMarkdown, unmask, mask } from './config.js';
import { migrateAgent, migrateProvider, migrateModel } from './migrate.js';
import { discoverDocuments, documentCatalog, readDocument, replacePrompt, writableDocument } from './documents.js';
import { compileRequiredRules, requiredProfiles, REQUIRED_PLUGIN, REQUIRED_DIRECTORY, REQUIRED_OWNER, MAINTENANCE_AGENTS } from './required-skills.js';

const text = entry => Buffer.from(entry.data, 'base64').toString('utf8');
const entry = (value, previous) => ({ type: 'file', data: Buffer.from(value).toString('base64'), mode: previous?.mode ?? 0o600 });

export class Studio {
  constructor(root, historyDirectory, options = {}) {
    this.root = fs.realpathSync(root);
    if (historyDirectory === this.root || historyDirectory.startsWith(this.root + path.sep)) throw new Error('История должна храниться вне конфигурации');
    this.home = options.home;
    this.documents = discoverDocuments(this.root, this.home);
    this.runtimeSkills = [];
    this.history = new History(this.root, historyDirectory, this.documents.filter(d => !d.readonly && d._key.startsWith('@external/')).map(d => d._file));
  }

  close() { this.history.close(); }

  snapshot() {
    this.documents = documentCatalog(discoverDocuments(this.root, this.home), this.runtimeSkills);
    for (const doc of this.documents) if (!doc.readonly && doc._key?.startsWith('@external/')) this.history.external.add(doc._file);
    return this.history.capture();
  }

  inventory(runtime) {
    this.runtimeSkills = runtime.skills;
    this.availableModels = runtime.models;
    this.snapshot();
    return { models: runtime.models, documents: this.documents.map(({ _file, _key, _prompt, ...doc }) => ({ ...doc, historyKey: _key })) };
  }

  document(id) {
    this.snapshot();
    return readDocument(this.documents.find(d => d.id === id));
  }

  cli() {
    const file = capture(this.root)['cli.json'];
    if (file && file.type !== 'file') throw new Error('cli.json является симлинком');
    return { value: mask(file ? jsonc(text(file)) : {}) };
  }

  state() {
    const files = this.snapshot();
    return {
      revision: fingerprint(files),
      ...catalog(files),
      files: Object.entries(files).filter(([, f]) => f.type !== 'directory').map(([name, f]) => ({ name, type: f.type, bytes: f.type === 'file' ? Buffer.from(f.data, 'base64').length : 0 })),
      history: this.history.list(),
      excluded: EXCLUDED,
      scope: 'Глобальная конфигурация · ~/.config/opencode',
      documents: this.documents.map(({ _file, _key, _prompt, ...doc }) => ({ ...doc, historyKey: _key })),
    };
  }

  assertRevision(revision, files) {
    if (revision !== fingerprint(files)) {
      const error = new Error('Конфигурация изменилась извне или в другой вкладке. Обновите данные; ваши правки остались в редакторе.');
      error.status = 409;
      throw error;
    }
  }

  save({ revision, title, edits }) {
    const before = this.snapshot();
    this.assertRevision(revision, before);
    if (!Array.isArray(edits) || !edits.length || edits.length > 50) throw new Error('Нужен список изменений (1–50)');
    if (typeof title !== 'string' || !title.trim() || title.length > 200) throw new Error('Добавьте описание сохранения (до 200 символов)');
    const after = structuredClone(before);
    for (const edit of edits) {
      if (edit.type === 'agent') this.editAgent(after, edit);
      else if (edit.type === 'delete-agent') this.deleteAgent(after, edit.id);
      else if (edit.type === 'document') {
        const doc = this.documents.find(d => d.id === edit.id);
        if (!doc || doc.readonly || !doc._file || !writableDocument(doc._file)) throw new Error('Инструкция readonly: симлинк, встроенный или защищённый источник');
        if (typeof edit.prompt !== 'string' || !after[doc._key]) throw new Error('Некорректная инструкция');
        after[doc._key] = { ...after[doc._key], data: Buffer.from(replacePrompt(text(after[doc._key]), edit.prompt, doc.kind)).toString('base64') };
      }
      else if (edit.type === 'model') {
        if (typeof edit.model !== 'string' || !/^[^/#]+\/[^#]+$/.test(edit.model)) throw new Error('Нужен базовый ID модели provider/model без #variant');
        const [provider, ...parts] = edit.model.split('/');
        const model = parts.join('/');
        const configs = ['opencode.jsonc', 'opencode.json'].filter(name => after[name]?.type === 'file');
        const file = configs.find(name => jsonc(text(after[name])).providers?.[provider]) || configs.find(name => jsonc(text(after[name])).provider?.[provider]) || configs[0] || 'opencode.json';
        const original = after[file] ? text(after[file]) : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
        const config = jsonc(original);
        const section = config.providers?.[provider] ? 'providers' : config.provider?.[provider] ? 'provider' : 'providers';
        const previous = config[section]?.[provider]?.models?.[model] || {};
        const value = edit.patch ? migrateModel(previous) : migrateModel(unmask(object(edit.value, 'Параметры модели'), migrateModel(previous)));
        if (edit.patch) for (const [key, next] of Object.entries(object(edit.patch))) {
          if (!['limit.context', 'limit.input', 'limit.output', 'settings.reasoningEffort', 'capabilities.tools', 'disabled'].includes(key)) throw new Error('Недопустимый параметр модели');
          if (key.startsWith('limit.') && next !== null && (!Number.isSafeInteger(next) || next <= 0)) throw new Error('Лимит должен быть положительным целым');
          if (['disabled', 'capabilities.tools'].includes(key) && next !== null && typeof next !== 'boolean') throw new Error('Ожидается boolean');
          if (key === 'settings.reasoningEffort' && next !== null && typeof next !== 'string') throw new Error('Ожидается строка');
          const parts = key.split('.');
          if (parts.length === 1) { if (next === null) delete value[key]; else value[key] = next; }
          else { value[parts[0]] ||= {}; if (next === null) delete value[parts[0]][parts[1]]; else value[parts[0]][parts[1]] = next; }
        }
        if (value.limit) for (const limit of Object.values(value.limit)) if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Лимиты модели должны быть положительными целыми числами');
        if (value.limit?.context && value.limit.output && value.limit.output > value.limit.context) throw new Error('Лимит вывода не может превышать контекстное окно');
        let updated = original;
        if (section === 'provider') {
          updated = editJson(updated, ['providers', provider], migrateProvider(config.provider[provider]));
          updated = editJson(updated, ['provider', provider], undefined);
        }
        after[file] = entry(editJson(updated, ['providers', provider, 'models', model], value), after[file]);
      }
      else if (edit.type === 'config') {
        if (!['opencode.json', 'opencode.jsonc', 'cli.json', 'cli.jsonc'].includes(edit.file)) throw new Error('Этот конфиг недоступен для редактирования');
        if (after[edit.file] && after[edit.file].type !== 'file') throw new Error('Конфиг-ссылка доступен только для чтения');
        const original = after[edit.file] ? text(after[edit.file]) : '{}';
        const previous = jsonc(original);
        const value = unmask(object(edit.value), previous);
        if (edit.file.startsWith('opencode.')) validateConfig(value);
        let updated = original;
        for (const key of new Set([...Object.keys(previous), ...Object.keys(value)])) {
          if (JSON.stringify(previous[key]) !== JSON.stringify(value[key])) updated = editJson(updated, [key], value[key]);
        }
        after[edit.file] = entry(updated, after[edit.file]);
      } else if (edit.type === 'text') {
        if (!/^(?:AGENTS\.md|(?:rules|commands|command)\/.+\.(?:md|mdc|txt|yaml|yml))$/.test(edit.file)) throw new Error('Редактирование этого файла не поддерживается');
        safePath(this.root, edit.file);
        if (after[edit.file]?.type !== 'file' || typeof edit.text !== 'string') throw new Error('Файл недоступен для редактирования');
        if (edit.text.includes('⟪секрет')) throw new Error('Секретные файлы нельзя редактировать как текст');
        after[edit.file] = entry(edit.text, after[edit.file]);
      } else throw new Error('Неизвестный тип изменения');
    }
    this.history.commit(before, after, title.trim());
    return this.state();
  }

  editAgent(files, edit) {
    if (typeof edit.id !== 'string' || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(edit.id) || edit.id.length > 150) throw new Error('ID агента: латиница, цифры, дефис, подчёркивание; допустим team/name');
    if (typeof edit.prompt !== 'string') throw new Error('Промпт должен быть строкой');
    const agent = catalog(files).agents.find(a => a.id === edit.id);
    if (agent?.forceConflict && !edit.resetRequiredSkills) throw new Error('Права форсированных скиллов изменены вне Studio. Сначала сбросьте старое форсирование в редакторе.');
    const source = agent?.sources.at(-1);
    if (edit.create && agent) throw new Error('Агент с таким ID уже существует');
    let previous;
    if (source?.section) previous = jsonc(text(files[source.file]))[source.section][edit.id];
    else if (source) previous = markdown(text(files[source.file])).settings;
    else previous = {};
    const settings = migrateAgent(unmask(object(edit.settings), migrateAgent(previous).settings)).settings;
    const originalRules = settings.permissions || [];
    const required = compileRequiredRules(originalRules);
    if ('permissions' in settings) settings.permissions = required.permissions;
    validateAgent(settings);
    const forcedIds = originalRules.filter(rule => rule.effect === 'force').map(rule => rule.resource);
    if (forcedIds.length) {
      if (MAINTENANCE_AGENTS.includes(edit.id)) throw new Error('Форсирование доступно для рабочих агентов, не для служебных title/summary/compaction');
      const available = new Set(this.documents.filter(doc => doc.kind === 'skill').map(doc => doc.skillId));
      for (const id of forcedIds) if (!available.has(id)) throw new Error('Форсированный скилл отсутствует в каталоге. Обновите каталог и выберите доступный скилл.');
    }
    const reference = value => typeof value === 'string' ? value : value ? `${value.providerID}/${value.model}${value.variant ? '#' + value.variant : ''}` : '';
    const model = reference(settings.model);
    if (model && model !== reference(migrateAgent(previous).settings.model) && this.availableModels) {
      const [base, variant] = model.split('#');
      const available = this.availableModels.find(m => m.ref === base && m.enabled !== false);
      if (!available || variant && !available.variants.includes(variant)) throw new Error('Выберите доступную модель и вариант из каталога OpenCode');
    }
    if (source?.section) {
      const value = { ...settings, system: edit.prompt };
      let updated = text(files[source.file]);
      if (source.section !== 'agents') updated = editJson(updated, [source.section, edit.id], undefined);
      files[source.file] = entry(editJson(updated, ['agents', edit.id], value), files[source.file]);
    } else {
      const file = source?.file || `agents/${edit.id}.md`;
      safePath(this.root, file);
      if (files[file] && files[file].type !== 'file') throw new Error('Файл агента является симлинком');
      const original = files[file] ? text(files[file]) : '';
      files[file] = entry(editMarkdown(original, settings, edit.prompt), files[file]);
      const parts = file.split('/');
      for (let i = 1; i < parts.length; i++) {
        const directory = parts.slice(0, i).join('/');
        if (files[directory] && files[directory].type !== 'directory') throw new Error('Родитель агента не является обычным каталогом');
        files[directory] ||= { type: 'directory', mode: 0o700 };
      }
    }
    this.updateRequiredSkills(files, edit.id, originalRules, required.skills);
  }

  updateRequiredSkills(files, id, rules, skills) {
    const names = ['opencode.json', 'opencode.jsonc'].filter(name => files[name]?.type === 'file');
    const configs = names.map(name => jsonc(text(files[name])));
    const agents = requiredProfiles(configs);
    const configured = rules.some(rule => rule.effect === 'force');
    if (!configured && !Object.hasOwn(agents, id)) return;
    if (configured) agents[id] = { skills, rules }; else delete agents[id];
    const active = Object.keys(agents).length > 0;
    const target = names.at(-1) || 'opencode.json';
    const sourceFile = `${REQUIRED_DIRECTORY}/index.js`;
    const packageFile = `${REQUIRED_DIRECTORY}/package.json`;
    const marker = '// Generated runtime definition owned by OpenCode Studio.';
    for (const file of [sourceFile, packageFile]) {
      safePath(this.root, file);
      if (files[file] && (files[file].type !== 'file' || (file === sourceFile ? !text(files[file]).startsWith(marker) : jsonc(text(files[file])).name !== REQUIRED_OWNER))) throw new Error('Каталог служебного плагина занят чужими файлами; ничего не перезаписано');
    }
    for (const name of new Set([...names, target])) {
      if (files[name] && files[name].type !== 'file') throw new Error('Конфигурация плагина readonly');
      const original = files[name] ? text(files[name]) : '{"$schema":"https://opencode.ai/config.json"}';
      const config = jsonc(original);
      if (config.plugins !== undefined && !Array.isArray(config.plugins)) throw new Error('plugins: ожидается массив');
      const plugins = (config.plugins || []).filter(plugin => plugin?.package !== REQUIRED_PLUGIN);
      const touched = plugins.length !== (config.plugins || []).length || name === target && active;
      if (name === target && active) plugins.push({ package: REQUIRED_PLUGIN, options: { studioVersion: 1, agents } });
      if (touched) files[name] = entry(editJson(original, ['plugins'], plugins), files[name]);
    }
    if (!active) { delete files[sourceFile]; delete files[packageFile]; return; }
    for (const directory of ['local-plugins', REQUIRED_DIRECTORY]) {
      if (files[directory] && files[directory].type !== 'directory') throw new Error('Каталог служебного плагина readonly');
      files[directory] ||= { type: 'directory', mode: 0o700 };
    }
    files[sourceFile] = entry(fs.readFileSync(new URL('../runtime/required-skills.js', import.meta.url), 'utf8'), files[sourceFile]);
    files[packageFile] = entry(JSON.stringify({ name: REQUIRED_OWNER, version: '1.0.0', type: 'module', exports: './index.js' }, null, 2) + '\n', files[packageFile]);
  }

  deleteAgent(files, id) {
    const agent = catalog(files).agents.find(a => a.id === id);
    if (!agent) throw new Error('Агент не найден');
    for (const source of agent.sources) {
      if (source.section) files[source.file] = entry(editJson(text(files[source.file]), [source.section, id], undefined), files[source.file]);
      else delete files[source.file];
    }
    if (agent.builtin) {
      const file = ['opencode.jsonc', 'opencode.json'].find(name => files[name]?.type === 'file') || 'opencode.json';
      const original = files[file] ? text(files[file]) : '{"$schema":"https://opencode.ai/config.json"}';
      files[file] = entry(editJson(original, ['agents', id], { disabled: true }), files[file]);
    }
    const replacement = catalog(files).agents.find(a => a.id !== id && !a.settings.disabled && !a.settings.disable && !a.settings.hidden && ['primary', 'all'].includes(a.settings.mode || 'primary'));
    for (const file of ['opencode.json', 'opencode.jsonc']) if (files[file]?.type === 'file' && jsonc(text(files[file])).default_agent === id) files[file] = entry(editJson(text(files[file]), ['default_agent'], replacement?.id), files[file]);
    this.updateRequiredSkills(files, id, [], []);
  }

  restore({ revision, id }) {
    const before = this.snapshot();
    this.assertRevision(revision, before);
    const event = this.history.events().find(x => x.id === id);
    if (!event) throw new Error('Снимок не найден');
    const after = structuredClone(event.files);
    for (const [key, value] of Object.entries(before)) if (value.external && !after[key]) after[key] = value;
    this.history.commit(before, after, `Откат: ${event.title}`.slice(0, 200), 'restore');
    return this.state();
  }

  preview({ revision, id }) {
    const before = this.snapshot();
    this.assertRevision(revision, before);
    const event = this.history.events().find(x => x.id === id);
    if (!event) throw new Error('Снимок не найден');
    const after = { ...event.files };
    for (const [key, value] of Object.entries(before)) if (value.external && !after[key]) after[key] = value;
    return { title: event.title, changed: changes(before, after) };
  }

  readFile(name) {
    safePath(this.root, name);
    if (!/^(?:AGENTS\.md|(?:rules|commands|command)\/.+\.(?:md|mdc|txt|yaml|yml))$/.test(name)) throw new Error('Файл недоступен в текстовом редакторе');
    const file = capture(this.root)[name];
    if (file?.type !== 'file') throw new Error('Симлинки и внешние файлы доступны только для чтения в OpenCode');
    const content = text(file);
    // Arbitrary instruction files may contain credentials; refuse rather than partially redact.
    if (/(?:api.?key|secret|password|authorization|access.?token)\s*[=:]\s*["']?(?!\{(?:env|file):)\S+/i.test(content)) throw new Error('Возможный секрет в текстовом файле: откройте его локальным редактором');
    return { text: content };
  }
}
