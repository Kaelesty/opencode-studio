import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { documentKey, writableDocument } from './documents.js';

export const EXCLUDED = ['node_modules', '.git', '.DS_Store', '.cache', 'cache', 'logs', 'dist', 'auth.json', 'service.json', 'opencode-notifier-state.json', 'bin/openkode-runtime'];
const excluded = name => name.split('/').some(part => EXCLUDED.includes(part)) || EXCLUDED.includes(name) || /(?:^|\/)(?:\.env(?:\..*)?|.*\.(?:pem|key|p12))$/.test(name);

export function safePath(root, name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes('\0') || path.posix.normalize(name) !== name || name.startsWith('/') || name.split('/').includes('..') || excluded(name)) throw new Error('Недопустимый путь конфигурации');
  const parts = name.split('/');
  for (let i = 1; i < parts.length; i++) {
    const parent = path.join(root, ...parts.slice(0, i));
    if (fs.existsSync(parent) && fs.lstatSync(parent).isSymbolicLink()) throw new Error('Внешние цели симлинков не редактируются');
  }
  return path.join(root, name);
}

export function capture(root, external = []) {
  const result = Object.create(null);
  let total = 0;
  const walk = (directory, prefix = '') => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + item.name;
      if (excluded(name) || item.name.startsWith('.studio-')) continue;
      const full = path.join(directory, item.name);
      const stat = fs.lstatSync(full);
      const mode = stat.mode & 0o777;
      if (stat.isSymbolicLink()) result[name] = { type: 'link', target: fs.readlinkSync(full), mode };
      else if (stat.isDirectory()) {
        result[name] = { type: 'directory', mode };
        walk(full, name + '/');
      } else if (stat.isFile()) {
        total += stat.size;
        if (stat.size > 4 * 1024 * 1024 || total > 32 * 1024 * 1024) throw new Error('Конфигурация слишком велика для безопасного снимка (4 МБ/файл, 32 МБ суммарно)');
        result[name] = { type: 'file', data: fs.readFileSync(full).toString('base64'), mode };
      } else throw new Error('Неподдерживаемый тип файла в конфигурации');
    }
  };
  walk(root);
  if (result['@external']) throw new Error('Имя @external зарезервировано для истории внешних инструкций');
  for (const file of external) {
    if (!writableDocument(file)) continue;
    if (!fs.existsSync(file)) continue;
    const stat = fs.statSync(file);
    total += stat.size;
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024 || total > 32 * 1024 * 1024) throw new Error('Внешние инструкции превышают лимит снимка');
    result[documentKey(file)] = { type: 'file', data: fs.readFileSync(file).toString('base64'), mode: stat.mode & 0o777, external: file };
  }
  return result;
}

export const fingerprint = files => crypto.createHash('sha256').update(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
export const changes = (before, after) => [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(name => JSON.stringify(before[name]) !== JSON.stringify(after[name])).sort();

export function atomicWrite(file, data, mode = 0o600) {
  const temporary = path.join(path.dirname(file), `.studio-${crypto.randomUUID()}`);
  const fd = fs.openSync(temporary, 'wx', mode);
  try {
    fs.fchmodSync(fd, mode);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, file); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

export function applySnapshot(root, before, after) {
  const names = changes(before, after);
  const resolve = name => {
    const value = after[name] || before[name];
    if (!name.startsWith('@external/')) return safePath(root, name);
    if (!value.external || documentKey(value.external) !== name || !writableDocument(value.external)) throw new Error('Внешняя инструкция стала readonly; откат заблокирован');
    return value.external;
  };
  for (const name of names) resolve(name);
  // Remove children before parents; never recurse through a link or an unmanaged directory.
  for (const name of [...names].sort((a, b) => b.split('/').length - a.split('/').length)) {
    if (!before[name] || before[name].type === after[name]?.type) continue;
    const full = resolve(name);
    if (before[name].type === 'directory') fs.rmdirSync(full);
    else fs.unlinkSync(full);
  }
  for (const name of names.sort((a, b) => a.split('/').length - b.split('/').length)) {
    const entry = after[name];
    if (!entry) continue;
    const full = resolve(name);
    fs.mkdirSync(path.dirname(full), { recursive: true, mode: 0o700 });
    if (entry.type === 'directory') {
      fs.mkdirSync(full, { recursive: true, mode: entry.mode });
      fs.chmodSync(full, entry.mode);
    } else if (entry.type === 'link') {
      if (before[name]?.type === 'link') fs.unlinkSync(full);
      fs.symlinkSync(entry.target, full);
    } else atomicWrite(full, Buffer.from(entry.data, 'base64'), entry.mode);
  }
}
