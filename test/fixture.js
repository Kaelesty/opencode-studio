import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function fixture() {
  const parent = fileURLToPath(new URL('../test-results/', import.meta.url));
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'fixture-'));
  const root = path.join(directory, 'config');
  fs.mkdirSync(root);
  const put = (name, value) => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), value);
  };
  put('opencode.jsonc', `{
  // Keep this comment.
  "model": "example/coder",
  "default_agent": "assistant",
  "agents": { "build": { "mode": "primary" } },
  "providers": { "example": { "settings": { "apiKey": "fixture-secret-value" }, "models": { "coder": { "settings": { "reasoningEffort": "medium" }, "variants": [{"id": "high", "settings": {"reasoningEffort": "high"}}] } } } },
  "mcp": { "servers": { "example": { "type": "remote", "url": "https://example.invalid", "headers": { "Authorization": "fixture-bearer-value" } } } },
}
`);
  put('cli.json', '{"theme":"system"}');
  put('agents/assistant.md', '---\n# Keep YAML comment.\ndescription: Test assistant\nmode: primary\nmodel: example/coder\npermission:\n  task:\n    "*": deny\n---\nOriginal prompt\n');
  put('agents/ensemble.md', '---\ndescription: Ensemble\nmode: primary\n---\nEnsemble prompt\n');
  put('agents/stable-duty.md', '---\ndescription: Stable duty\nmode: primary\n---\nDuty prompt\n');
  put('agents/hidden.md', '---\nhidden: true\nmode: subagent\n---\nHidden prompt\n');
  put('rules/local.md', '# Shared rules\n');
  put('commands/check.md', 'Run relevant checks.\n');
  put('auth.json', '{"token":"not-in-snapshots"}');
  put('.env', 'SECRET=not-in-snapshots');
  put('node_modules/ignored.txt', 'not-in-snapshots');
  const history = path.join(directory, 'history');
  return { directory, root, history, put, read: name => fs.readFileSync(path.join(root, name), 'utf8'), cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}
