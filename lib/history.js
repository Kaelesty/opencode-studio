import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWrite, applySnapshot, capture, changes, fingerprint } from './files.js';

export class History {
  constructor(root, directory, external = []) {
    this.root = root;
    this.directory = directory;
    this.external = new Set(external);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Каталог истории не должен быть симлинком');
    fs.chmodSync(directory, 0o700);
    const lock = path.join(directory, 'lock');
    try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(fs.readFileSync(lock, 'utf8'));
      if (!Number.isInteger(pid) || pid < 1) throw new Error('Некорректная блокировка истории; проверьте файл lock');
      try { process.kill(pid, 0); throw new Error('Эта конфигурация уже открыта в другом Studio'); }
      catch (check) {
        if (check.code !== 'ESRCH') throw check;
        fs.unlinkSync(lock);
        fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
      }
    }
    this.lock = lock;
    try {
      const keyFile = path.join(directory, 'key');
      if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 });
      if (fs.lstatSync(keyFile).isSymbolicLink()) throw new Error('Ключ истории не должен быть симлинком');
      fs.chmodSync(keyFile, 0o600);
      this.key = fs.readFileSync(keyFile);
      if (this.key.length !== 32) throw new Error('Повреждён ключ истории');
      const binding = path.join(directory, 'root');
      const rootHash = crypto.createHash('sha256').update(fs.realpathSync(root)).digest('hex');
      if (fs.existsSync(binding) && fs.readFileSync(binding, 'utf8') !== rootHash) throw new Error('История принадлежит другой конфигурации');
      if (!fs.existsSync(binding)) fs.writeFileSync(binding, rootHash, { mode: 0o600, flag: 'wx' });
      for (const event of this.events()) this.track(event.files);
      if (fs.existsSync(path.join(directory, 'pending'))) {
        const pending = this.read('pending');
        this.track(pending.before);
        this.track(pending.event.files);
      }
      this.recover();
    } catch (error) { this.close(); throw error; }
  }

  close() {
    if (this.lock) { fs.unlinkSync(this.lock); this.lock = null; }
  }

  track(files) {
    for (const value of Object.values(files)) if (value.external) this.external.add(value.external);
  }

  capture() { return capture(this.root, this.external); }

  write(name, value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    atomicWrite(path.join(this.directory, name), Buffer.concat([iv, cipher.getAuthTag(), encrypted]));
  }

  read(name) {
    const data = fs.readFileSync(path.join(this.directory, name));
    const cipher = crypto.createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
    cipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString());
  }

  events() {
    return fs.readdirSync(this.directory).filter(name => /^\d+-[a-f0-9-]+\.snapshot$/.test(name)).map(name => this.read(name)).sort((a, b) => a.id.localeCompare(b.id));
  }

  list() {
    return this.events().reverse().map(({ files, ...event }) => ({ ...event, fileCount: Object.values(files).filter(x => x.type !== 'directory').length }));
  }

  event(files, title, kind, changed, parent = null) {
    const latest = this.events().at(-1)?.id.split('-')[0] || 0;
    const timestamp = Math.max(Date.now(), Number(latest) + 1);
    return { id: `${timestamp}-${crypto.randomUUID()}`, date: new Date(timestamp).toISOString(), title, kind, changed, parent, hash: fingerprint(files), files };
  }

  recover() {
    const pending = path.join(this.directory, 'pending');
    if (!fs.existsSync(pending)) return;
    const { before, event } = this.read('pending');
    const committed = fs.existsSync(path.join(this.directory, `${event.id}.snapshot`));
    const current = this.capture();
    const target = structuredClone(committed ? event.files : before);
    // A journal from an older Studio may not know newly enrolled external skills.
    for (const [key, value] of Object.entries(current)) if (value.external && !before[key] && !event.files[key]) target[key] = value;
    applySnapshot(this.root, current, target);
    fs.unlinkSync(pending);
  }

  commit(before, after, title, kind = 'save') {
    if (fs.existsSync(path.join(this.directory, 'pending'))) throw new Error('Есть незавершённая запись. Перезапустите Studio для восстановления.');
    if (fingerprint(this.capture()) !== fingerprint(before)) throw new Error('Конфигурация изменилась извне. Обновите данные перед сохранением.');
    const changed = changes(before, after);
    if (!changed.length) return;
    let events = this.events();
    if (!events.length || events.at(-1).hash !== fingerprint(before)) {
      const baseline = this.event(before, events.length ? 'Внешние изменения перед сохранением' : 'Исходная конфигурация', events.length ? 'external' : 'baseline', events.length ? changes(events.at(-1).files, before) : []);
      this.write(`${baseline.id}.snapshot`, baseline);
      events.push(baseline);
    }
    const event = this.event(after, title, kind, changed, events.at(-1).id);
    this.write('pending', { before, event });
    try {
      applySnapshot(this.root, before, after);
      if (fingerprint(this.capture()) !== event.hash) throw new Error('Не удалось проверить сохранённую конфигурацию');
      this.write(`${event.id}.snapshot`, event);
      fs.unlinkSync(path.join(this.directory, 'pending'));
    } catch (error) {
      try { this.recover(); } catch { throw new Error('Сохранение прервано. Журнал восстановления оставлен; перезапустите Studio.'); }
      throw error;
    }
  }
}
