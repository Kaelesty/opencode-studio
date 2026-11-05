export const REQUIRED_PLUGIN = './local-plugins/studio-required-skills';
export const REQUIRED_DIRECTORY = 'local-plugins/studio-required-skills';
export const REQUIRED_OWNER = 'opencode-studio-required-skills';
export const MAINTENANCE_AGENTS = ['title', 'summary', 'compaction'];

const match = (pattern, value) => new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.') + '$', process.platform === 'win32' ? 'i' : '').test(value);

export function compileRequiredRules(rules) {
  if (!Array.isArray(rules)) throw new Error('permissions: ожидается массив правил');
  for (const rule of rules) {
    if (!rule || typeof rule.action !== 'string' || typeof rule.resource !== 'string' || !['allow', 'ask', 'deny', 'force'].includes(rule.effect)) throw new Error('Некорректное правило доступа');
    if (rule.effect !== 'force') continue;
    if (rule.action !== 'skill' || typeof rule.resource !== 'string' || !rule.resource || /[*?\r\n\0]/.test(rule.resource)) throw new Error('Форсировать можно только конкретный скилл, без wildcard');
  }
  const candidates = [...new Set(rules.filter(rule => rule.effect === 'force').map(rule => rule.resource))];
  const skills = candidates.filter(id => rules.findLast(rule => match(rule.action, 'skill') && match(rule.resource, id))?.effect === 'force');
  return { permissions: rules.map(rule => ({ ...rule, effect: rule.effect === 'force' ? 'allow' : rule.effect })), skills };
}

export function requiredProfiles(configs) {
  const agents = Object.create(null);
  for (const config of configs) for (const plugin of Array.isArray(config.plugins) ? config.plugins : []) {
    if (plugin?.package === REQUIRED_PLUGIN && plugin.options?.studioVersion === 1) Object.assign(agents, plugin.options.agents || {});
  }
  return agents;
}

export function requiredView(settings, profile) {
  if (!profile) return { settings, conflict: false, skills: [] };
  try {
    const compiled = compileRequiredRules(profile.rules);
    const canonical = rules => rules.map(rule => [rule.action, rule.resource, rule.effect]);
    if (JSON.stringify(canonical(compiled.permissions)) !== JSON.stringify(canonical(settings.permissions || [])) || JSON.stringify(compiled.skills) !== JSON.stringify(profile.skills)) return { settings, conflict: true, skills: profile.skills || [] };
    return { settings: { ...settings, permissions: profile.rules }, conflict: false, skills: profile.skills || [] };
  } catch { return { settings, conflict: true, skills: profile.skills || [] }; }
}
