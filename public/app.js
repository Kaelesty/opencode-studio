const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pretty = value => JSON.stringify(value, null, 2);
const primaryIds = ['assistant', 'ensemble', 'stable-duty', 'build', 'plan'];
const icons = { assistant: '⌁', ensemble: '◈', 'stable-duty': '⌖', build: '⌘', plan: '▤' };
const names = { agents: 'Агенты', models: 'Модели', documents: 'Скиллы и правила', config: 'Конфигурация', history: 'История' };
const colors = { '': 'По умолчанию', '#7160d5': 'Фиолетовый', '#4e8e91': 'Бирюзовый', '#6389bb': 'Синий', '#72ad91': 'Зелёный', '#be8d53': 'Янтарный', '#c16882': 'Розовый', '#b65353': 'Красный', '#777987': 'Серый' };
const permissionActions = ['*', 'read', 'edit', 'glob', 'grep', 'shell', 'subagent', 'skill', 'question', 'webfetch', 'websearch', 'external_directory', 'execute', 'experimental_image_generate', 'opencode_list_mcp_resources', 'opencode_read_mcp_resource'];
let availableModels = [];
let catalogLoaded = false;
let catalogError = '';
let state;
let view = 'agents';
let drafts = new Map();
let editing;
let restoreId;
let toastTimer;

async function api(endpoint, data) {
  const response = await fetch(`/api/${endpoint}`, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio-Request': '1' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Не удалось выполнить запрос');
  return result;
}

function toast(message, error = false) {
  const element = $('#toast');
  clearTimeout(toastTimer);
  element.textContent = message;
  element.classList.toggle('error', error);
  element.hidden = false;
  toastTimer = setTimeout(() => { element.hidden = true; }, error ? 12000 : 4500);
}

function mode(agent) {
  return agent.settings.mode || (['build', 'plan'].includes(agent.id) ? 'primary' : agent.builtin ? 'subagent' : 'primary');
}
function modelName(value) {
  return typeof value === 'object' && value ? `${value.providerID}/${value.model}${value.variant ? '#' + value.variant : ''}` : value || '';
}
function effectiveAgent(agent) {
  const draft = drafts.get(`agent:${agent.id}`);
  return draft ? { ...agent, ...draft, editableSettings: draft.settings, v2Settings: draft.settings } : agent;
}
function allAgents() {
  const agents = state.agents.map(effectiveAgent);
  for (const [key, draft] of drafts) if (key.startsWith('agent:') && !agents.some(a => a.id === draft.id)) agents.push({ ...draft, sources: [], legacy: false });
  return agents.filter(a => !drafts.has(`delete:${a.id}`) && !a.settings.disabled && !a.settings.disable);
}
function badge(agent) {
  const off = agent.settings.disabled || agent.settings.disable;
  return off ? '<span class="badge off">Выключен</span>' : agent.settings.hidden ? '<span class="badge">Скрытый</span>' : `<span class="badge ${mode(agent) === 'primary' ? 'purple' : ''}">${escape(mode(agent))}</span>`;
}

function render() {
  $('#crumb').textContent = names[view];
  $$('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  $('#agent-count').textContent = allAgents().length;
  $('#history-count').textContent = state.history.length;
  $('#draft-bar').hidden = drafts.size === 0;
  $('#dirty-status').textContent = drafts.size ? 'Есть несохранённые изменения' : 'Все изменения сохранены';
  $('#dirty-status').classList.toggle('unsaved', drafts.size > 0);
  $('#draft-count').textContent = `${drafts.size} ${drafts.size === 1 ? 'изменение' : 'изменения'} в черновике`;
  if (view === 'agents') renderAgents();
  if (view === 'config') renderConfig();
  if (view === 'history') renderHistory();
  if (view === 'models') renderModels();
  if (view === 'documents') renderDocuments();
}

function intro(eyebrow, title, subtitle, action = '') {
  return `<div class="page-heading"><div><span class="eyebrow">${eyebrow}</span><h1>${title}</h1><p class="subtitle">${subtitle}</p></div>${action}</div>`;
}

function renderAgents() {
  const agents = allAgents();
  const main = primaryIds.map(id => agents.find(a => a.id === id)).filter(Boolean);
  const others = agents.filter(a => !primaryIds.includes(a.id));
  $('#content').innerHTML = intro('YOUR AGENT WORKSPACE', 'Твой harness. Твои правила.', 'Промпты, модели и границы доступа — в одном пространстве.', '<button class="button primary" id="new-agent"><span>＋</span> Новый агент</button>') + `
    ${state.warnings.length ? `<div class="notice warning">${state.warnings.map(escape).join('<br>')}</div>` : ''}
    <div class="section-heading"><h2>Основные агенты <span class="count-pill">${main.length}</span></h2><span class="muted small">Твоя команда для ежедневной работы</span></div>
    <div class="agent-grid">${main.map((agent, i) => `<button class="agent-card tint-${i}" data-agent="${escape(agent.id)}"><div class="card-top"><span class="agent-icon">${icons[agent.id] || '◈'}</span>${badge(agent)}</div><h3>${escape(agent.id)}${drafts.has(`agent:${agent.id}`) ? '<span class="changed-dot" aria-label="Есть черновик"></span>' : ''}</h3><p class="card-description">${escape(agent.settings.description || 'Настрой поведение агента под свой процесс.')}</p><div class="card-model"><span>◉</span><span>${escape(modelName(agent.settings.model) || 'Модель сессии / по умолчанию')}</span></div><div class="card-bottom"><span>${agent.builtin && !agent.sources.length ? 'Встроенный · override' : agent.legacy ? 'Пользовательский · V1' : 'Пользовательский'}</span><span class="card-arrow">↗</span></div></button>`).join('')}
      <button id="add-card" class="agent-card add-card"><span class="add-circle">＋</span><h3>Собери своего агента</h3><p>Отдельная роль. Свои инструкции.<br>Ровно столько доступа, сколько нужно.</p><span class="text-link">Создать агента ↗</span></button>
    </div>
    <div class="catalog-section"><div class="section-heading"><div><h2>Остальные агенты <span class="count-pill">${others.length}</span></h2><p class="muted small">Подагенты, встроенные роли и вспомогательные инструменты</p></div><div class="catalog-tools"><label class="search-field"><span>⌕</span><input id="search" type="search" placeholder="Найти агента…" aria-label="Найти агента"></label><select id="filter" aria-label="Фильтр агентов"><option value="all">Все роли</option><option value="subagent">Подагенты</option><option value="primary">Основные</option><option value="hidden">Скрытые</option></select></div></div><div id="agent-list" class="agent-list"></div></div>
    <div class="page-note"><span>↶</span> Без автосохранения. Применение — только по кнопке «Сохранить».</div>`;
  const renderList = () => {
    const query = $('#search').value.toLowerCase();
    const filter = $('#filter').value;
    const list = others.filter(a => `${a.id} ${a.settings.description || ''}`.toLowerCase().includes(query) && (filter === 'all' || filter === 'hidden' ? filter !== 'hidden' || a.settings.hidden : mode(a) === filter || mode(a) === 'all'));
    $('#agent-list').innerHTML = list.length ? `<div class="list-header"><span>АГЕНТ / НАЗНАЧЕНИЕ</span><span>МОДЕЛЬ</span><span>РОЛЬ</span><span></span></div>${list.map(a => `<button class="agent-row" data-agent="${escape(a.id)}"><span class="row-identity"><span class="row-icon">${a.settings.hidden ? '◌' : '◇'}</span><span><strong>${escape(a.id)}${drafts.has(`agent:${a.id}`) ? ' •' : ''}</strong><small>${escape(a.settings.description || (a.builtin ? 'Встроенный агент OpenCode' : 'Пользовательский агент'))}</small></span></span><span class="row-model">${escape(modelName(a.settings.model) || 'Наследуется')}</span>${badge(a)}<span class="row-arrow">↗</span></button>`).join('')}` : '<div class="empty-state">Ничего не найдено. Попробуй другой запрос.</div>';
  };
  $$('.agent-card[data-agent]').forEach(card => { card.dataset.color = agents.find(a => a.id === card.dataset.agent)?.settings.color || ''; });
  $('#search').addEventListener('input', renderList);
  $('#filter').addEventListener('change', renderList);
  renderList();
  $('#new-agent').onclick = $('#add-card').onclick = () => openAgent();
}

function renderConfig() {
  const configs = [...state.configs];
  if (!configs.length) configs.push({ name: 'opencode.json', value: { $schema: 'https://opencode.ai/config.json' } });
  $('#content').innerHTML = intro('HARNESS CONFIGURATION', 'Всё, что за кулисами.', 'Глобальные настройки, модели, права и инструкции. Без потери незнакомых полей.') + `
    <div class="notice"><span>ⓘ</span><div>Это глобальная конфигурация. Настройки проекта, системные политики и выбранная модель текущей сессии могут иметь приоритет.</div></div>
    <div class="config-grid">${configs.map(c => { const value = drafts.get(`config:${c.name}`)?.value || c.value; return `<button class="config-card" data-config="${escape(c.name)}"><span class="config-icon">{ }</span><span class="badge">JSONC</span><h3>${escape(c.name)}</h3><p>Модели, провайдеры, MCP, плагины, права и все остальные настройки.</p><div class="config-detail">По умолчанию <strong>${escape(value.default_agent || 'build')}</strong></div><div class="config-detail">Модель <strong>${escape(modelName(value.model) || 'Из каталога')}</strong></div><div class="card-bottom"><span>${drafts.has(`config:${c.name}`) ? 'Есть черновик' : 'Редактировать все поля'}</span><span>↗</span></div></button>`; }).join('')}
      <button class="config-card" data-config="cli.json"><span class="config-icon">⌨</span><span class="badge">CLI</span><h3>Терминальный интерфейс</h3><p>cli.json: тема, горячие клавиши и поведение терминального клиента.</p><div class="card-bottom"><span>Открыть JSON-редактор</span><span>↗</span></div></button>
    </div>
    <div class="section-heading"><h2>Правила и команды</h2><span class="muted small">Внешние симлинки не изменяются</span></div>
    <div class="file-list">${state.files.filter(f => /^(AGENTS\.md|(?:rules|commands|command)\/)/.test(f.name)).map(f => `<button class="file-row" data-file="${escape(f.name)}" ${f.type === 'link' || !/\.(md|mdc|txt|yaml|yml)$/.test(f.name) ? 'disabled' : ''}><span class="file-icon">${f.type === 'link' ? '↗' : '▤'}</span><span>${escape(f.name)}</span><span class="muted small">${f.type === 'link' ? 'Симлинк · без перехода' : `${Math.ceil(f.bytes / 1024)} КБ`}</span></button>`).join('') || '<div class="empty-state">Дополнительных правил и команд нет.</div>'}</div>
    <details class="scope-details"><summary>Что входит в полный откат?</summary><p>Все файлы глобального каталога, включая агентов, правила, команды, конфиги, исходники плагинов и симлинки (без перехода к внешним целям). Восстанавливаются также удалённые файлы и права доступа. Отдельные симлинки показываются ниже.</p><p>Исключения: ${state.excluded.map(escape).join(', ')}, файлы .env и ключи *.pem/*.key/*.p12. Сессии и хранилище авторизации OpenCode не затрагиваются. Указанные в конфиге внешние файлы не входят в снимок.</p><p>Снимки зашифрованы локальным ключом. Это не резервная копия от потери диска; потеря ключа делает историю недоступной.</p><ul>${state.files.filter(f => f.type === 'link').map(f => `<li>${escape(f.name)} · цель не читается</li>`).join('')}</ul></details>`;
}

function renderHistory() {
  $('#content').innerHTML = intro('CONFIGURATION STORYLINE', 'История твоих экспериментов.', 'Каждое сохранение — полная точка восстановления. Откат тоже остаётся в истории.') + `
    <div class="history-banner"><span class="history-art">↶</span><div><strong>Ничего не теряется</strong><p>Перед первым изменением сохраним исходное состояние. Перед откатом покажем список затронутых файлов.</p></div><span class="badge purple">LOCAL & ENCRYPTED</span></div>
    ${state.history.length ? `<div class="timeline">${state.history.map((event, i) => `<article class="timeline-event"><span class="timeline-dot ${i === 0 ? 'latest' : ''}"></span><div class="event-meta"><time datetime="${escape(event.date)}">${escape(new Intl.DateTimeFormat('ru', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(event.date)))}</time>${i === 0 ? '<span class="badge purple">Последняя точка</span>' : ''}<span class="badge">${{ save: 'Сохранение', baseline: 'Исходное состояние', external: 'Внешние изменения', restore: 'Откат' }[event.kind] || escape(event.kind)}</span></div><div class="event-card"><div class="event-heading"><div><h3>${escape(event.title)}</h3><p class="muted small">${event.fileCount} файлов в снимке · ${event.changed.length} изменений</p></div><button class="button" data-restore="${escape(event.id)}">Восстановить <span>↶</span></button></div>${event.changed.length ? `<details><summary>Изменённые файлы</summary><ul class="changed-files">${event.changed.map(name => `<li>${escape(name)}</li>`).join('')}</ul></details>` : '<p class="muted small">Полный снимок до первого изменения</p>'}</div></article>`).join('')}</div>` : '<div class="empty-state empty-history"><span>◷</span><h2>История начинается с сохранения</h2><p>Настрой агента и нажми «Сохранить». Мы запомним и новое, и исходное состояние.</p><button class="button" id="back-to-agents">К агентам ↗</button></div>'}`;
  if ($('#back-to-agents')) $('#back-to-agents').onclick = () => navigate('agents');
  $$('.changed-files li', $('#content')).forEach(item => { item.textContent = historyName(item.textContent); });
}

function field(label, name, value, extra = '') {
  return `<label class="field"><span>${label}</span><input name="${name}" value="${escape(value)}" ${extra}></label>`;
}
function modelDefinition(reference) {
  const base = reference.split('#')[0];
  const [provider, ...parts] = base.split('/');
  const id = parts.join('/');
  for (const section of ['providers', 'provider']) for (const config of [...state.configs].reverse()) {
    const value = (drafts.get(`config:${config.name}`)?.value || config.value)[section]?.[provider];
    if (value) return { value: drafts.get(`model:${base}`)?.value || value.models?.[id] || {}, old: section === 'provider' };
  }
  return { value: drafts.get(`model:${base}`)?.value || {}, old: false };
}

function renderModels() {
  $('#content').innerHTML = intro('MODEL CATALOG', 'Модели твоего OpenCode.', 'Провайдеры, варианты и лимиты — без ручного ввода идентификаторов.', '<button id="refresh-catalog" class="button">↻ Обновить каталог</button>') + `${catalogError ? `<div class="notice warning">${escape(catalogError)}</div>` : ''}<div class="notice compact">Контекстное окно — локальная настройка OpenCode. Она не увеличивает реальный лимит API. Общие параметры модели действуют на всех использующих её агентов.</div><div class="catalog-tools model-tools"><label class="search-field"><span>⌕</span><input id="model-search" type="search" placeholder="Найти модель…" aria-label="Найти модель"></label>${selectField('Провайдер', 'provider-filter', { '': 'Все провайдеры', ...listChoices(availableModels.map(m => m.provider).sort()) })}</div><div id="models-list" class="agent-list"></div>`;
  const update = () => {
    const query = $('#model-search').value.toLowerCase();
    const provider = $('[name=provider-filter]').value;
    const models = availableModels.filter(m => (!provider || m.provider === provider) && `${m.name} ${m.ref}`.toLowerCase().includes(query));
    $('#models-list').innerHTML = models.map(m => `<button class="model-row" data-model="${escape(m.ref)}"><span class="row-icon">◉</span><span><strong>${escape(m.name)}</strong><small>${escape(m.ref)}</small></span><span class="badge purple">${escape(drafts.get('model:' + m.ref)?.patch?.['limit.context'] || modelDefinition(m.ref).value.limit?.context || m.limit.context)} context</span><span class="row-arrow">↗</span></button>`).join('') || `<div class="empty-state">${catalogLoaded ? 'Модели не найдены.' : 'Каталог OpenCode ещё не загружен. Нажми «Обновить каталог».'}</div>`;
  };
  $('#model-search').oninput = $('[name=provider-filter]').onchange = update;
  update();
}

function openModel(reference) {
  if ([...drafts.keys()].some(k => k.startsWith('config:'))) return toast('Сначала сохрани или сбрось полный конфиг.', true);
  const model = availableModels.find(m => m.ref === reference);
  const definition = modelDefinition(reference);
  const value = definition.value;
  const pending = drafts.get('model:' + reference)?.patch || {};
  const selected = (key, current) => String(key in pending ? pending[key] ?? '' : current ?? '');
  const controls = [
    ['Контекстное окно', 'limit.context', [8192, 16384, 32768, 65536, 131072, 200000, 262144, 524288, 1000000, 1048576, 2000000], value.limit?.context, model.limit.context],
    ['Максимальный ввод', 'limit.input', [8192, 16384, 32768, 65536, 131072, 200000, 262144, 524288, 1000000], value.limit?.input, model.limit.input],
    ['Максимальный вывод', 'limit.output', [1024, 2048, 4096, 8192, 16384, 32768, 65536, 128000, 131072], value.limit?.output, model.limit.output],
  ];
  editing = { type: 'model', model: reference, patch: { ...pending }, initial: {} };
  $('#editor-title').textContent = model.name;
  $('#editor-eyebrow').textContent = 'MODEL SETTINGS · ' + reference;
  $('#delete-agent').hidden = true;
  $('#editor-submit').hidden = false;
  $('#editor-body').innerHTML = `<div class="notice compact">${definition.old ? 'При сохранении провайдер и его модели перейдут в V2. ' : ''}Изменяются только выбранные параметры. Остальная конфигурация провайдера сохраняется.</div><div class="field-grid">${controls.map(([label, key, presets, configured, inherited]) => selectField(label, key, { '': `По умолчанию${inherited ? ' · ' + inherited : ''}`, ...Object.fromEntries([...new Set([...presets, configured, inherited, pending[key]].filter(n => n > 0))].sort((a, b) => a - b).map(n => [n, n.toLocaleString('ru') + ' токенов'])) }, String(key in pending ? pending[key] ?? '' : configured ?? ''))).join('')}${selectField('Инструменты', 'capabilities.tools', { '': 'По умолчанию', true: 'Поддерживаются', false: 'Не поддерживаются' }, String(pending['capabilities.tools'] ?? value.capabilities?.tools ?? value.tool_call ?? ''))}${selectField('Доступность', 'disabled', { '': 'По умолчанию', false: 'Включена', true: 'Выключена' }, String(pending.disabled ?? value.disabled ?? ''))}${model.efforts?.length ? selectField('Reasoning effort', 'settings.reasoningEffort', { '': 'По умолчанию', ...listChoices([...model.efforts, value.settings?.reasoningEffort || value.options?.reasoningEffort].filter(Boolean)) }, pending['settings.reasoningEffort'] ?? value.settings?.reasoningEffort ?? value.options?.reasoningEffort ?? '') : ''}</div><div class="field-heading"><strong>Доступные варианты</strong></div><div class="variant-chips">${model.variants.map(v => `<span class="badge purple">${escape(v)}</span>`).join('') || '<span class="muted small">Нет вариантов. Их список предоставляет OpenCode.</span>'}</div><p class="muted small">Вариант для конкретного агента выбирается в его настройках. Новые произвольные варианты здесь не создаются.</p><p id="editor-error" class="inline-error" role="alert" hidden></p>`;
  $$('select', $('#editor-body')).forEach(input => { if (input.name in pending) input.value = selected(input.name); editing.initial[input.name] = input.value; });
  $('#editor').showModal();
}

function renderDocuments() {
  $('#content').innerHTML = intro('SKILLS & INSTRUCTIONS', 'Инструкции без чёрного ящика.', 'Промпты скиллов, базовый AGENTS.md и правила твоего harness.', '<button id="refresh-catalog" class="button">↻ Обновить каталог</button>') + `${catalogError ? `<div class="notice warning">${escape(catalogError)}</div>` : ''}<div class="catalog-tools model-tools"><label class="search-field"><span>⌕</span><input id="document-search" type="search" placeholder="Найти инструкцию…" aria-label="Найти инструкцию"></label>${selectField('Раздел', 'document-filter', { all: 'Все инструкции', skill: 'Скиллы', base: 'AGENTS.md', rule: 'Правила' }, 'all')}</div><div id="documents-list" class="file-list"></div><p class="page-note">Симлинки и встроенные источники — только чтение. Изменения обычных файлов входят в историю.</p>`;
  const update = () => {
    const query = $('#document-search').value.toLowerCase();
    const kind = $('[name=document-filter]').value;
    const docs = state.documents.filter(d => (kind === 'all' || d.kind === kind) && `${d.name} ${d.source} ${d.description}`.toLowerCase().includes(query));
    $('#documents-list').innerHTML = docs.map(d => `<button class="document-row" data-document="${escape(d.id)}"><span class="row-icon">${d.linked ? '↗' : d.kind === 'skill' ? '◇' : '▤'}</span><span><strong>${escape(d.name)}</strong><small>${escape(d.description || d.source)}</small></span><span class="badge ${d.readonly ? '' : 'purple'}">${d.readonly ? d.linked ? 'Симлинк · readonly' : 'Readonly' : 'Можно редактировать'}</span><span>↗</span></button>`).join('') || '<div class="empty-state">Инструкции не найдены.</div>';
  };
  $('#document-search').oninput = $('[name=document-filter]').onchange = update;
  update();
}

async function openDocument(id) {
  const doc = state.documents.find(d => d.id === id);
  const result = await api('document?id=' + encodeURIComponent(id));
  editing = { type: 'document', id, readonly: result.readonly };
  $('#editor-title').textContent = doc.name;
  $('#editor-eyebrow').textContent = doc.kind === 'skill' ? 'SKILL PROMPT' : 'HARNESS INSTRUCTIONS';
  $('#delete-agent').hidden = true;
  $('#editor-submit').hidden = result.readonly;
  $('#editor-body').innerHTML = `<div class="editor-source">${escape(doc.source)}</div>${result.readonly ? '<div class="notice compact">Источник readonly: симлинк, встроенный скилл или защищённый каталог. Промпт можно просмотреть и скопировать, но не изменить.</div>' : '<div class="notice compact">Редактируется промпт. Frontmatter скилла сохраняется. Изменение применяется только через «Сохранить» и доступно для отката.</div>'}<textarea id="document-prompt" class="code-editor full-config-editor" spellcheck="false" aria-label="Промпт инструкции" ${result.readonly ? 'readonly' : ''}>${escape(drafts.get('document:' + id)?.prompt ?? result.prompt)}</textarea><p id="editor-error" class="inline-error" role="alert" hidden></p>`;
  $('#editor').showModal();
}

function selectField(label, name, choices, value = '') {
  return `<label class="field"><span>${label}</span><select name="${name}">${Object.entries(choices).map(([key, text]) => `<option value="${escape(key)}" ${String(value) === key ? 'selected' : ''}>${escape(text)}</option>`).join('')}</select></label>`;
}
const listChoices = values => Object.fromEntries([...new Set(values)].map(value => [value, value]));
const draftName = draft => draft.type === 'document' ? state.documents.find(d => d.id === draft.id)?.name || 'Инструкция' : draft.type === 'delete-agent' ? 'Удалить ' + draft.id : draft.id || draft.model || draft.file;
const historyName = key => state.documents.find(d => d.historyKey === key)?.source || key;
async function loadCatalog(refresh = false) {
  try {
    const result = await api('catalog' + (refresh ? '?refresh=1' : ''));
    availableModels = result.models.sort((a, b) => a.name.localeCompare(b.name, 'ru', { sensitivity: 'base', numeric: true }) || a.ref.localeCompare(b.ref, 'ru', { sensitivity: 'base', numeric: true }));
    state.documents = result.documents;
    catalogLoaded = true;
    catalogError = '';
  } catch (error) { catalogError = error.message; throw error; }
}

async function openAgent(id) {
  if (!catalogLoaded) { try { await loadCatalog(); } catch { /* Keep prompt and access editing available while offline. */ } }
  const agent = id ? allAgents().find(a => a.id === id) : { id: '', settings: { mode: 'primary', description: '' }, prompt: '', legacy: false, sources: [] };
  editing = { type: 'agent', agent, create: !id, resetRequiredSkills: drafts.get('agent:' + id)?.resetRequiredSkills || false };
  $('#editor-title').textContent = id || 'Новый агент';
  $('#editor-eyebrow').textContent = 'AGENT SETTINGS';
  $('#editor-submit').hidden = false;
  $('#delete-agent').hidden = !id;
  const setting = agent.v2Settings || agent.settings;
  const model = modelName(setting.model);
  const base = model.split('#')[0];
  const selectableModels = availableModels.filter(m => m.enabled !== false);
  const modelChoices = { '': 'Наследовать модель сессии', ...Object.fromEntries(selectableModels.map(m => [m.ref, `${m.name} · ${m.ref}`])), ...(base && !selectableModels.some(m => m.ref === base) ? { [base]: `${base} · сейчас недоступна` } : {}) };
  $('#editor-body').innerHTML = `
    <div class="editor-source">${agent.sources?.length ? `Источник: <code>${escape(agent.sources.at(-1).file)}</code>${agent.sources.length > 1 ? ` · ${agent.sources.length} слоя, правки в последнем` : ''}` : agent.builtin ? 'Встроенный агент · сохранение создаст пользовательское переопределение' : 'Новый Markdown-агент в agents/'}</div>
    ${agent.forceConflict ? `<div id="force-conflict" class="notice warning compact">Права менялись вне Studio. Форсированные скиллы: ${escape((agent.requiredSkills || []).join(', '))}. Старое форсирование нужно явно сбросить перед сохранением.<button type="button" class="button small-button" id="reset-required">Сбросить старое форсирование</button></div>` : ''}
    ${agent.legacy ? `<div class="notice warning compact">При сохранении агент перейдёт в V2: права и ссылка модели будут преобразованы.${agent.migrationRemoved?.length ? ` Убираем неработающие legacy-поля: ${agent.migrationRemoved.map(escape).join(', ')}. Для reasoning выбери доступный вариант модели.` : ''}</div>` : ''}
    <div class="tabs" role="tablist" aria-label="Разделы настроек"><button type="button" role="tab" aria-selected="true" data-tab="general">Общее</button><button type="button" role="tab" aria-selected="false" data-tab="prompt">Промпт</button><button type="button" role="tab" aria-selected="false" data-tab="model">Модель</button><button type="button" role="tab" aria-selected="false" data-tab="permissions">Доступ</button><button type="button" role="tab" aria-selected="false" data-tab="advanced">Все поля</button></div>
    <section data-panel="general" class="editor-panel"><div class="field-grid">${field('ID агента', 'id', agent.id, id ? 'readonly' : 'required placeholder="my-agent"')}${field('Описание', 'description', setting.description || '', 'placeholder="Когда использовать этого агента"')}</div><div class="field-grid">${selectField('Роль', 'mode', { primary: 'Основной агент', subagent: 'Подагент', all: 'Оба режима' }, setting.mode || mode(agent))}${selectField('Цвет в OpenCode', 'color', { ...colors, ...(setting.color && !colors[setting.color] ? { [setting.color]: setting.color } : {}) }, setting.color || '')}</div><label class="checkbox"><input name="hidden" type="checkbox" ${setting.hidden ? 'checked' : ''}> Скрыть из каталога OpenCode</label><div class="notice compact">Изменение базового агента не меняет модель уже открытой сессии. Глобальные инструкции и skills добавляются к его промпту отдельно.</div></section>
    <section data-panel="prompt" class="editor-panel" hidden><div class="field-heading"><strong>Системный промпт</strong><span class="muted small">Markdown · ${agent.builtin && !agent.sources?.length ? 'переопределение встроенного' : 'инструкции агента'}</span></div><textarea id="agent-prompt" class="code-editor prompt-editor" spellcheck="false" aria-label="Системный промпт" placeholder="Как агент должен мыслить и действовать…">${escape(agent.prompt)}</textarea><p class="muted small">Ссылки {file:…} сохраняются как ссылки и не раскрываются редактором.</p>${agent.builtin ? '<button type="button" class="button small-button" id="runtime-prompt">Посмотреть встроенный промпт через OpenCode</button><div id="runtime-preview" hidden></div>' : ''}</section>
    <section data-panel="model" class="editor-panel" hidden>${catalogError ? `<div class="notice warning">${escape(catalogError)}</div>` : ''}${selectField('Модель агента', 'model', modelChoices, base)}<div id="variant-field"></div><p class="muted small">Список доступных моделей и вариантов получен из OpenCode. Общие настройки, включая контекстное окно, находятся в меню «Модели».</p></section>
    <section data-panel="permissions" class="editor-panel" hidden><div class="field-heading"><strong>Права и ограничения</strong><button type="button" id="add-permission" class="button small-button">＋ Правило</button></div><p class="muted small">Действие, ресурс и эффект выбираются из списков. Последнее подходящее правило побеждает.</p><div id="permission-rules"></div><div class="notice compact">Права агента не обходят системные политики. Пустой список не означает запрет всех инструментов.</div></section>
    <section data-panel="advanced" class="editor-panel" hidden><div class="field-heading"><strong>Все параметры агента</strong><span class="muted small">JSON · неизвестные поля сохраняются</span></div><textarea id="agent-settings" class="code-editor advanced-editor" spellcheck="false" aria-label="Все параметры агента JSON">${escape(pretty(setting))}</textarea><p class="muted small">Промпт редактируется отдельно. Проверяем синтаксис и основные поля, но не полную схему установленного OpenCode.</p></section>
    <p id="editor-error" class="inline-error" role="alert" hidden></p>`;
  const sync = () => JSON.parse($('#agent-settings').value);
  const updateVariants = variant => {
    const reference = $('[name=model]').value;
    const model = availableModels.find(m => m.ref === reference);
    $('#variant-field').innerHTML = selectField('Вариант модели', 'variant', { '': 'По умолчанию', ...listChoices(model?.variants || []), ...(variant && !model?.variants.includes(variant) ? { [variant]: `${variant} · сейчас недоступен` } : {}) }, variant || '');
    $('[name=variant]').disabled = !reference;
    $('[name=variant]').onchange = () => {
      const value = sync();
      value.model = reference + ($('[name=variant]').value ? '#' + $('[name=variant]').value : '');
      $('#agent-settings').value = pretty(value);
    };
  };
  const renderRules = () => {
    const rules = sync().permissions || [];
    const known = [...state.agents.flatMap(a => a.v2Settings?.permissions || []), ...state.configs.flatMap(c => Array.isArray(c.value.permissions) ? c.value.permissions : [])];
    const actions = listChoices([...permissionActions, ...known.map(r => r.action), ...rules.map(r => r.action)]);
    $('#permission-rules').innerHTML = rules.map((rule, index) => {
      const resources = ['*', ...known.filter(r => r.action === rule.action).map(r => r.resource), rule.resource, ...(rule.action === 'subagent' ? allAgents().map(a => a.id) : rule.action === 'skill' ? state.documents.filter(d => d.kind === 'skill').map(d => d.skillId || d.name) : [])];
      const canForce = rule.action === 'skill' && !['title', 'summary', 'compaction'].includes(agent.id);
      const skillIds = state.documents.filter(doc => doc.kind === 'skill').map(doc => doc.skillId).filter(Boolean);
      const targets = rule.effect === 'force' ? { '': 'Выберите скилл', ...listChoices([...new Set([...skillIds, rule.resource].filter(r => r && !/[?*]/.test(r)))].sort()) } : listChoices(resources);
      return `<div class="permission-rule" data-rule="${index}">${selectField('Действие', 'action', actions, rule.action)}${selectField('Ресурс', 'resource', targets, rule.resource)}${selectField('Эффект', 'effect', { allow: 'Разрешить', ask: 'Спросить', deny: 'Запретить', ...(canForce ? { force: 'Форсировать · автозагрузка' } : {}) }, rule.effect)}<div class="rule-actions"><button type="button" data-move="-1" aria-label="Поднять правило" ${index === 0 ? 'disabled' : ''}>↑</button><button type="button" data-move="1" aria-label="Опустить правило" ${index === rules.length - 1 ? 'disabled' : ''}>↓</button><button type="button" data-remove="1" aria-label="Удалить правило">×</button></div></div>`;
    }).join('') || '<div class="empty-state">Нет собственных правил. Действуют базовые и глобальные права.</div>';
    $$('[data-rule]').forEach(row => {
      const index = Number(row.dataset.rule);
      $$('select', row).forEach(input => input.onchange = () => {
        const value = sync();
        value.permissions[index][input.name] = input.value;
        if (input.name === 'action') {
          value.permissions[index].resource = '*';
          if (value.permissions[index].effect === 'force') value.permissions[index].effect = 'ask';
        }
        if (input.name === 'effect' && input.value === 'force' && /[?*]/.test(value.permissions[index].resource)) value.permissions[index].resource = '';
        $('#agent-settings').value = pretty(value);
        renderRules();
      });
      $$('button', row).forEach(button => button.onclick = () => {
        const value = sync();
        if (button.dataset.remove) value.permissions.splice(index, 1);
        else { const next = index + Number(button.dataset.move); [value.permissions[index], value.permissions[next]] = [value.permissions[next], value.permissions[index]]; }
        $('#agent-settings').value = pretty(value);
        renderRules();
      });
    });
  };
  updateVariants(model.split('#')[1]);
  renderRules();
  const forceNote = document.createElement('p');
  forceNote.className = 'muted small';
  forceNote.textContent = 'Для skill «Форсировать» автоматически загружает инструкции перед запросами рабочего агента. Первый Save подключит локальный плагин Studio. Native-права остаются allow/ask/deny; системные запреты не обходятся.';
  $('#permission-rules').after(forceNote);
  $('#add-permission').onclick = () => { const value = sync(); (value.permissions ||= []).push({ action: 'read', resource: '*', effect: 'ask' }); $('#agent-settings').value = pretty(value); renderRules(); };
  $$('[name]', $('[data-panel=general]')).concat([$('[name=model]')]).forEach(input => input.addEventListener('input', () => {
    if (input.name === 'id') return;
    try {
      const value = JSON.parse($('#agent-settings').value);
      const key = input.name;
      let next = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
      if (input.value === '' && input.type !== 'checkbox') delete value[key]; else value[key] = next;
      $('#agent-settings').value = pretty(value);
      if (input.name === 'model') updateVariants('');
    } catch (error) { showEditorError(error.message); }
  }));
  $$('[data-tab]').forEach(button => button.onclick = () => {
    try {
      const settings = sync();
      const activeTab = button.dataset.tab;
      if (activeTab === 'permissions') renderRules();
      if (activeTab === 'general' || activeTab === 'model') {
        $$('[name]', $('[data-panel=general]')).concat([$('[name=model]')]).forEach(input => {
          if (input.name === 'id') return;
          const key = input.name;
          if (input.type === 'checkbox') input.checked = Boolean(settings[key]); else input.value = key === 'model' ? modelName(settings.model).split('#')[0] : settings[key] ?? '';
        });
        updateVariants(modelName(settings.model).split('#')[1]);
      }
      $$('[data-tab]').forEach(t => t.setAttribute('aria-selected', String(t === button)));
      $$('[data-panel]').forEach(panel => { panel.hidden = panel.dataset.panel !== activeTab; });
      $('#editor-error').hidden = true;
    } catch (error) { showEditorError('Некорректный JSON: ' + error.message); }
  });
  editing.sync = sync;
  if ($('#reset-required')) $('#reset-required').onclick = () => { editing.resetRequiredSkills = true; $('#force-conflict').textContent = 'Старое форсирование будет сброшено после «Сохранить». Текущие native-права сохранены в редакторе.'; };
  if ($('#runtime-prompt')) $('#runtime-prompt').onclick = async () => {
    $('#runtime-prompt').disabled = true;
    try {
      const runtime = await api('runtime-agent?id=' + encodeURIComponent(agent.id));
      const preview = $('#runtime-preview');
      preview.hidden = false;
      preview.innerHTML = `<div class="notice compact">Текущий Agent.Info из установленного OpenCode. Это runtime-просмотр, не редактируемый слой. Провайдер-зависимый базовый промпт, инструкции проекта и skills могут добавляться отдельно. Запрос может запустить фоновый сервис OpenCode.</div><textarea class="code-editor model-editor" id="runtime-text" readonly aria-label="Runtime-промпт">${escape(runtime.prompt || 'У этого агента нет статического system-промпта в API. Базовый промпт выбирается во время запроса.')}</textarea>${runtime.prompt ? '<button type="button" class="button small-button" id="copy-runtime">Использовать как пользовательский промпт</button>' : ''}`;
      if ($('#copy-runtime')) $('#copy-runtime').onclick = () => { $('#agent-prompt').value = runtime.prompt; toast('Промпт скопирован в редактор, но ещё не сохранён.'); };
    } catch (error) { showEditorError(error.message); }
    finally { $('#runtime-prompt').disabled = false; }
  };
  $('#editor').showModal();
}

function showEditorError(message) { $('#editor-error').textContent = message; $('#editor-error').hidden = false; }

async function openConfig(name) {
  if ([...drafts.keys()].some(k => k.startsWith('agent:') || k.startsWith('model:') || k.startsWith('delete:'))) {
    toast('Сначала сохрани или сбрось черновики агентов/моделей — чтобы не перезаписать их полным конфигом.', true);
    return;
  }
  let config = state.configs.find(c => c.name === name)?.value;
  if (!config && name === 'cli.json') {
    // CLI JSON is loaded through the dedicated endpoint, with credentials masked.
    config = (await api('cli')).value;
  }
  config = drafts.get(`config:${name}`)?.value || config || {};
  editing = { type: 'config', file: name };
  $('#delete-agent').hidden = true;
  $('#editor-submit').hidden = false;
  $('#editor-title').textContent = name;
  $('#editor-eyebrow').textContent = 'FULL CONFIGURATION';
  $('#editor-body').innerHTML = `<div class="notice compact">Полный JSON-редактор. Комментарии в неизменённых разделах JSONC сохраняются. Маркеры секретов оставь без изменений; лучше использовать {env:…} и {file:…}.</div><textarea id="config-json" class="code-editor full-config-editor" spellcheck="false" aria-label="Конфигурация JSON">${escape(pretty(config))}</textarea><p class="muted small">Проверка синтаксиса и основных полей — не полная валидация всех плагинов и параметров провайдера.</p><p id="editor-error" class="inline-error" role="alert" hidden></p>`;
  $('#editor').showModal();
}

async function openText(file) {
  const result = await api('file?name=' + encodeURIComponent(file));
  editing = { type: 'text', file };
  $('#delete-agent').hidden = true;
  $('#editor-submit').hidden = false;
  $('#editor-title').textContent = file;
  $('#editor-eyebrow').textContent = 'INSTRUCTIONS & COMMANDS';
  $('#editor-body').innerHTML = `<textarea id="file-text" class="code-editor full-config-editor" spellcheck="false" aria-label="Текст файла">${escape(drafts.get(`text:${file}`)?.text ?? result.text)}</textarea><p id="editor-error" class="inline-error" role="alert" hidden></p>`;
  $('#editor').showModal();
}

$('#editor-form').onsubmit = event => {
  event.preventDefault();
  try {
    if (editing.type === 'agent') {
      if ([...drafts.keys()].some(k => k.startsWith('config:'))) throw new Error('Сначала сохрани или сбрось полный конфиг, затем редактируй агентов.');
      const settings = editing.sync();
      const id = $('[name=id]').value;
      if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(id)) throw new Error('ID: латиница, цифры, дефис, подчёркивание; допустим team/name');
      if (editing.create && allAgents().some(a => a.id === id)) throw new Error('Этот ID уже занят');
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Настройки должны быть объектом');
      drafts.set(`agent:${id}`, { type: 'agent', id, settings, prompt: $('#agent-prompt').value, create: editing.create || drafts.get(`agent:${id}`)?.create || false, resetRequiredSkills: editing.resetRequiredSkills || false });
    } else if (editing.type === 'model') {
      const patch = { ...editing.patch };
      $$('select', $('#editor-body')).forEach(input => {
        if (input.value === editing.initial[input.name]) return;
        patch[input.name] = input.value === '' ? null : input.name.startsWith('limit.') ? Number(input.value) : ['disabled', 'capabilities.tools'].includes(input.name) ? input.value === 'true' : input.value;
      });
      if (Object.keys(patch).length) drafts.set('model:' + editing.model, { type: 'model', model: editing.model, patch });
    } else if (editing.type === 'document') {
      if (editing.readonly) throw new Error('Эта инструкция доступна только для чтения');
      drafts.set('document:' + editing.id, { type: 'document', id: editing.id, prompt: $('#document-prompt').value });
    } else if (editing.type === 'config') {
      const value = JSON.parse($('#config-json').value);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Конфигурация должна быть объектом');
      drafts.set(`config:${editing.file}`, { ...editing, value });
    } else drafts.set(`text:${editing.file}`, { ...editing, text: $('#file-text').value });
    $('#editor').close();
    render();
    toast('В черновике. Для применения нажми «Сохранить».');
  } catch (error) { showEditorError(error.message); }
};

function navigate(next) { view = next; render(); window.scrollTo(0, 0); }
$$('[data-view]').forEach(button => button.onclick = () => navigate(button.dataset.view));
document.addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button) return;
  try {
    if (button.dataset.close) { $('#' + button.dataset.close).close(); return; }
    if (button.dataset.agent) await openAgent(button.dataset.agent);
    if (button.dataset.model) openModel(button.dataset.model);
    if (button.dataset.document) await openDocument(button.dataset.document);
    if (button.id === 'refresh-catalog') { await loadCatalog(true); render(); toast('Каталог OpenCode обновлён.'); }
    if (button.dataset.config) await openConfig(button.dataset.config);
    if (button.dataset.file) await openText(button.dataset.file);
    if (button.dataset.restore) {
      if (drafts.size) throw new Error('Перед откатом сохрани или сбрось текущие черновики.');
      const preview = await api('preview', { revision: state.revision, id: button.dataset.restore });
      if (!preview.changed.length) return toast('Конфигурация уже совпадает с этим снимком.');
      restoreId = button.dataset.restore;
      preview.changed = preview.changed.map(historyName);
      $('#confirm-title').textContent = 'Восстановить конфигурацию?';
      $('#confirm-action').textContent = 'Восстановить';
      $('#confirm-body').innerHTML = `<div class="notice warning">Будут восстановлены все файлы конфигурации, не только выбранный агент. Текущее состояние останется в истории.</div><p><strong>${escape(preview.title)}</strong></p><p class="muted">Затронуто файлов: ${preview.changed.length}</p><ul class="changed-files">${preview.changed.map(escape).map(name => `<li>${name}</li>`).join('')}</ul>`;
      $('#confirm').showModal();
    }
  } catch (error) { toast(error.message, true); }
});

$('#delete-agent').onclick = () => {
  if ([...drafts.keys()].some(k => k.startsWith('config:'))) return toast('Сначала сохрани или сбрось полный конфиг.', true);
  const id = editing.agent.id;
  if (!window.confirm(`Удалить ${id}? Встроенный агент будет отключён. Применение — по кнопке «Сохранить», отмена — через историю.`)) return;
  if (state.agents.some(a => a.id === id)) drafts.set('delete:' + id, { type: 'delete-agent', id });
  drafts.delete('agent:' + id);
  $('#editor').close();
  render();
};

$('#save').onclick = () => {
  if (!drafts.size) return;
  restoreId = null;
  $('#confirm-title').textContent = 'Сохранить изменения';
  $('#confirm-action').textContent = 'Сохранить';
  $('#confirm-body').innerHTML = `<label class="field"><span>Название точки истории</span><input id="save-title" required maxlength="200" placeholder="Например: новый промпт для assistant" value="${escape([...drafts.values()].map(draftName).join(', ').slice(0, 180))}"></label><p class="muted small">Применим ${drafts.size} изменений и сохраним полный снимок конфигурации.</p><ul class="changed-files">${[...drafts.values()].map(d => `<li>${escape(draftName(d))} <span class="muted">${escape(d.type)}</span></li>`).join('')}</ul>`;
  $('#confirm').showModal();
};
$('#confirm-form').onsubmit = async event => {
  event.preventDefault();
  $('#confirm-action').disabled = true;
  try {
    state = restoreId ? await api('restore', { revision: state.revision, id: restoreId }) : await api('save', { revision: state.revision, title: $('#save-title').value, edits: [...drafts.values()] });
    drafts.clear();
    $('#confirm').close();
    render();
    toast(restoreId ? 'Конфигурация восстановлена. Откат добавлен в историю.' : 'Сохранено. OpenCode автоматически перечитает конфигурацию.');
  } catch (error) { toast(error.message, true); }
  finally { $('#confirm-action').disabled = false; }
};
$('#discard').onclick = () => { if (window.confirm('Сбросить все несохранённые изменения?')) { drafts.clear(); render(); } };
$('#reload').onclick = async () => {
  if (drafts.size && !window.confirm('Перечитать конфигурацию и сбросить несохранённые черновики?')) return;
  try { state = await api('state'); drafts.clear(); render(); toast('Конфигурация перечитана.'); } catch (error) { toast(error.message, true); }
};
$('#theme').onclick = () => {
  document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('studio-theme', document.documentElement.dataset.theme);
};
document.documentElement.dataset.theme = localStorage.getItem('studio-theme') || 'light';
window.addEventListener('beforeunload', event => { if (drafts.size || $('#editor').open) { event.preventDefault(); event.returnValue = ''; } });
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key === 's') {
    event.preventDefault();
    if ($('#editor').open) $('#editor-form').requestSubmit(); else if (!$('#confirm').open) $('#save').click();
  }
});
try { state = await api('state'); render(); try { await loadCatalog(); if (!$('#editor').open && !$('#confirm').open) render(); } catch (error) { toast(error.message, true); } } catch (error) { $('#content').innerHTML = `<div class="empty-state"><h2>Не удалось прочитать конфигурацию</h2><p>${escape(error.message)}</p><p>Исправь файл локально и нажми ↻.</p></div>`; }
