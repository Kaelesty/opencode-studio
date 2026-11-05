const actions = { bash: 'shell', task: 'subagent', write: 'edit', patch: 'edit' };
export const actionName = action => actions[action] || action;

export function permissionRules(permission, tools = {}) {
  const rules = [];
  if (typeof permission === 'string') rules.push({ action: '*', resource: '*', effect: permission });
  else for (const [name, values] of Object.entries(permission || {})) {
    for (const [resource, effect] of Object.entries(typeof values === 'string' ? { '*': values } : values)) rules.push({ action: actionName(name), resource, effect });
  }
  for (const [name, enabled] of Object.entries(tools)) rules.push({ action: actionName(name), resource: '*', effect: enabled ? 'allow' : 'deny' });
  return rules;
}

export function migrateAgent(original) {
  const settings = structuredClone(original);
  const removed = [];
  if ('permission' in settings || 'tools' in settings) settings.permissions = [...permissionRules(settings.permission, settings.tools), ...settings.permissions || []];
  if ('disable' in settings) settings.disabled ??= settings.disable;
  if (settings.variant && settings.model) {
    if (typeof settings.model === 'string') settings.model = settings.model.split('#')[0] + '#' + settings.variant;
    else settings.model.variant ??= settings.variant;
  }
  if ('prompt' in settings) settings.system ??= settings.prompt;
  for (const key of ['temperature', 'top_p', 'options', 'reasoningEffort']) if (key in settings) removed.push(key);
  for (const key of ['permission', 'tools', 'disable', 'variant', 'prompt', 'name', 'maxSteps', 'steps', 'temperature', 'top_p', 'options', 'reasoningEffort']) delete settings[key];
  return { settings, removed };
}

export function migrateModel(original) {
  const value = structuredClone(original);
  if ('id' in value) value.modelID ??= value.id;
  if ('options' in value) value.settings = { ...value.options, ...value.settings };
  if ('tool_call' in value || value.modalities) value.capabilities = { ...('tool_call' in value ? { tools: value.tool_call } : {}), ...value.modalities, ...value.capabilities };
  if (value.status === 'deprecated') value.disabled = true;
  if (value.variants && !Array.isArray(value.variants)) value.variants = Object.entries(value.variants).map(([id, options]) => ({ id, settings: options }));
  const convertCost = cost => {
    const { cache_read, cache_write, ...rest } = cost;
    return { ...rest, ...(cache_read !== undefined || cache_write !== undefined ? { cache: { ...rest.cache, ...(cache_read !== undefined ? { read: cache_read } : {}), ...(cache_write !== undefined ? { write: cache_write } : {}) } } : {}) };
  };
  if (value.cost) value.cost = Array.isArray(value.cost) ? value.cost.map(convertCost) : convertCost(value.cost);
  for (const key of ['id', 'options', 'tool_call', 'modalities', 'status', 'release_date', 'attachment', 'reasoning', 'temperature', 'experimental', 'interleaved']) delete value[key];
  return value;
}

export function migrateProvider(original) {
  const { npm, api, options, id, whitelist, blacklist, models, ...value } = structuredClone(original);
  if (npm) value.package ??= npm.startsWith('@ai-sdk/') ? `aisdk:${npm}` : npm;
  if (api || options) {
    const { headers, body, setCacheKey, ...settings } = options || {};
    value.settings = { ...settings, ...(api ? { baseURL: api } : {}), ...value.settings };
    if (headers) value.headers = { ...headers, ...value.headers };
    if (body) value.body = { ...body, ...value.body };
    if (setCacheKey !== undefined) value.compatibility = { supportsPromptCacheKey: setCacheKey, ...value.compatibility };
  }
  if (models) value.models = Object.fromEntries(Object.entries(models).map(([name, model]) => [name, migrateModel(model)]));
  return value;
}
