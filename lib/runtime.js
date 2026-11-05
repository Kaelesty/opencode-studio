import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BUILTINS, mask } from './config.js';

const directory = fileURLToPath(new URL('../', import.meta.url));
function run(args) {
  return new Promise((resolve, reject) => {
    // The installed CLI can truncate large responses on pipes. A private regular file avoids that bug.
    const parent = path.join(os.tmpdir(), 'opencode');
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const temporary = fs.mkdtempSync(path.join(parent, 'studio-api-'));
    const output = path.join(temporary, 'response');
    const fd = fs.openSync(output, 'wx', 0o600);
    let finished = false;
    const finish = failed => {
      if (finished) return;
      finished = true;
      fs.closeSync(fd);
      try {
        if (failed || fs.statSync(output).size > 16 * 1024 * 1024) throw new Error();
        const value = fs.readFileSync(output, 'utf8');
        if (!value.trim()) throw new Error();
        resolve(value);
      } catch { reject(new Error('OpenCode API недоступен. Сырой ответ скрыт.')); }
      finally { fs.rmSync(temporary, { recursive: true, force: true }); }
    };
    const child = spawn('opencode', args, { cwd: directory, timeout: 15000, stdio: ['ignore', fd, 'ignore'] });
    child.once('error', () => finish(true));
    child.once('close', (_code, signal) => finish(Boolean(signal)));
  });
}

export async function runtimeCatalog(execute = run) {
  const read = async endpoint => {
    try {
      const result = JSON.parse(await execute(['api', 'get', endpoint]));
      if (!Array.isArray(result.data)) throw new Error();
      return result.data;
    } catch { throw new Error('Не удалось прочитать каталог OpenCode. Сырой ответ API скрыт, так как может содержать ключи.'); }
  };
  const [models, skills] = await Promise.all([read('/api/model'), read('/api/skill')]);
  return {
    models: models.map(m => ({ ref: `${m.providerID}/${m.id}`, id: m.id, provider: m.providerID, name: m.name, enabled: m.enabled, limit: { context: m.limit.context, input: m.limit.input, output: m.limit.output }, variants: m.variants.map(v => v.id), efforts: [...new Set(m.variants.map(v => v.settings?.reasoningEffort).filter(Boolean))], capabilities: { tools: m.capabilities.tools, input: m.capabilities.input, output: m.capabilities.output, temperature: m.capabilities.temperature } })),
    skills: skills.map(s => ({ id: s.id, name: s.name, description: s.description || '', path: s.path, prompt: s.content })),
  };
}

export async function runtimeAgent(id, execute = run) {
  if (!Object.hasOwn(BUILTINS, id)) throw new Error('Runtime-просмотр доступен для встроенных агентов');
  let result;
  try { result = JSON.parse(await execute(['api', 'get', `/api/agent/${id}`])); }
  catch { throw new Error('Не удалось прочитать агента через OpenCode V2 API. Пользовательские настройки по-прежнему доступны.'); }
  const agent = result.data;
  if (!agent || agent.id !== id) throw new Error('OpenCode вернул неожиданный ответ для агента');
  const { system, ...settings } = agent;
  return { prompt: typeof system === 'string' ? system : '', settings: mask(settings) };
}
