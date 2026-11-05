import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { jsonc, markdown } from './config.js';

export const documentKey = file => '@external/' + crypto.createHash('sha256').update(file).digest('hex');
export function linked(file) {
  for (let current = path.resolve(file); current !== path.dirname(current); current = path.dirname(current)) {
    try { if (fs.lstatSync(current).isSymbolicLink()) return true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return false;
}
export function writableDocument(file) {
  const main = path.join(os.homedir(), 'arcadia2');
  return !linked(file) && file !== main && !file.startsWith(main + path.sep);
}

export function discoverDocuments(root, home = os.homedir()) {
  const documents = new Map();
  let visits = 0;
  const add = (file, kind) => {
    if (++visits > 5000) throw new Error('Слишком большой каталог инструкций');
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return;
    if (fs.statSync(file).size > 4 * 1024 * 1024) throw new Error('Инструкция превышает 4 МБ');
    const id = crypto.createHash('sha256').update(file).digest('hex');
    const isLinked = linked(file);
    const relative = path.relative(root, file);
    const inside = relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative);
    const source = inside ? relative : file.startsWith(os.homedir() + path.sep) ? '~/' + path.relative(os.homedir(), file) : path.basename(path.dirname(file)) + '/' + path.basename(file);
    let name = kind === 'base' ? 'AGENTS.md' : kind === 'rule' ? source : path.basename(file) === 'SKILL.md' ? path.basename(path.dirname(file)) : path.basename(file, '.md');
    const skillId = kind === 'skill' ? name : undefined;
    let description = '';
    if (kind === 'skill') {
      try { const meta = markdown(fs.readFileSync(file, 'utf8')).settings; name = meta.name || name; description = meta.description || ''; } catch { /* The editor will report malformed frontmatter. */ }
    }
    documents.set(id, { id, name, skillId, description, kind, source, linked: isLinked, readonly: !writableDocument(file), _file: file, _key: inside ? relative : documentKey(file) });
  };
  const scan = (directory, kind, depth = 0, ancestors = new Set()) => {
    if (depth > 6 || !fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) return;
    const real = fs.realpathSync(directory);
    if (ancestors.has(real)) return;
    const visited = new Set([...ancestors, real]);
    if (kind === 'skill' && fs.existsSync(path.join(directory, 'SKILL.md'))) { add(path.join(directory, 'SKILL.md'), kind); return; }
    for (const item of fs.readdirSync(directory)) {
      if (item.startsWith('.') || item === 'node_modules') continue;
      if (++visits > 5000) throw new Error('Слишком большой каталог инструкций');
      const full = path.join(directory, item);
      if (!fs.existsSync(full)) continue;
      if (fs.statSync(full).isDirectory()) scan(full, kind, depth + 1, visited);
      else if (kind === 'rule' && /\.(md|mdc|txt|yaml|yml)$/.test(item) || kind === 'skill' && (item === 'SKILL.md' || depth === 0 && item.endsWith('.md'))) add(full, kind);
    }
  };
  add(path.join(root, 'AGENTS.md'), 'base');
  scan(path.join(root, 'rules'), 'rule');
  const roots = [path.join(home, '.claude/skills'), path.join(home, '.agents/skills'), path.join(root, 'skill'), path.join(root, 'skills')];
  for (const name of ['opencode.json', 'opencode.jsonc']) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    const config = jsonc(fs.readFileSync(file, 'utf8'));
    for (const source of Array.isArray(config.skills) ? config.skills : config.skills?.paths || []) {
      if (typeof source !== 'string' || /^https?:/.test(source)) continue;
      roots.push(source.startsWith('~/') ? path.join(home, source.slice(2)) : path.resolve(source));
    }
  }
  for (const source of new Set(roots)) scan(source, 'skill');
  return [...documents.values()];
}

export function documentCatalog(documents, runtimeSkills = []) {
  if (!runtimeSkills.length) return documents;
  const result = documents.filter(d => d.kind !== 'skill');
  for (const skill of runtimeSkills) {
    const existing = documents.find(d => d.kind === 'skill' && d._file === skill.path) || documents.find(d => d.kind === 'skill' && d._file && fs.existsSync(d._file) && fs.realpathSync(d._file) === skill.path);
    if (existing) result.push({ ...existing, id: 'runtime:' + skill.id, name: skill.name, description: skill.description, skillId: skill.id });
    else result.push({ id: 'runtime:' + skill.id, name: skill.name, skillId: skill.id, description: skill.description, kind: 'skill', source: 'OpenCode runtime', readonly: true, linked: false, _prompt: skill.prompt });
  }
  return result;
}

export function readDocument(document) {
  if (!document) throw new Error('Инструкция не найдена');
  if (!document._file) return { prompt: document._prompt, readonly: true };
  const original = fs.readFileSync(document._file, 'utf8');
  return { prompt: document.kind === 'skill' ? markdown(original).prompt : original, readonly: document.readonly || !writableDocument(document._file) };
}

export function replacePrompt(original, prompt, kind) {
  if (kind !== 'skill') return prompt;
  const frontmatter = original.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0] || '';
  return frontmatter + prompt;
}
