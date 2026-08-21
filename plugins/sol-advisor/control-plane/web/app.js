const fragment = new URLSearchParams(location.hash.slice(1));
const token = fragment.get('token') || '';
history.replaceState(null, '', location.pathname);

const state = { config: null, bundledDefaults: null, revision: '', storage: null, dirty: false };
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function toast(message, error = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = `show${error ? ' error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.className = ''; }, 3200);
}

async function api(path, options = {}) {
  if (!token) throw new Error('Console token is missing. Reopen the console from Sol Advisor.');
  const response = await fetch(path, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function field(labelText, input) {
  const label = document.createElement('label');
  const span = document.createElement('span');
  span.textContent = labelText;
  label.append(span, input);
  return label;
}

function textInput(value = '', className = '') {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  input.className = className;
  input.addEventListener('input', markDirty);
  return input;
}

function checkbox(value = false, className = '') {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = Boolean(value);
  input.className = className;
  input.addEventListener('change', markDirty);
  return input;
}

function selectInput(values, current, className = '') {
  const select = document.createElement('select');
  select.className = className;
  for (const value of values) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    option.selected = value === current;
    select.append(option);
  }
  select.addEventListener('change', markDirty);
  return select;
}

function textarea(value = '', className = '') {
  const input = document.createElement('textarea');
  input.value = value;
  input.className = className;
  input.addEventListener('input', markDirty);
  return input;
}

function grid(...children) {
  const el = document.createElement('div');
  el.className = 'grid two';
  el.append(...children);
  return el;
}

function markDirty() {
  state.dirty = true;
  setBadge('Unsaved', '');
}

function setBadge(text, kind = '') {
  const badge = $('#status-badge');
  badge.textContent = text;
  badge.className = `badge${kind ? ` ${kind}` : ''}`;
}

function providerCard(provider, index) {
  const details = document.createElement('details');
  details.className = 'card provider-card';
  details.dataset.index = String(index);
  const summary = document.createElement('summary');
  const title = document.createElement('span');
  title.textContent = provider.name;
  const meta = document.createElement('span');
  meta.className = 'card-meta';
  meta.textContent = `${provider.kind} · ${provider.enabled ? 'enabled' : 'disabled'}`;
  summary.append(title, meta);

  const body = document.createElement('div');
  body.className = 'card-body';
  const id = textInput(provider.id, 'provider-id');
  id.addEventListener('input', refreshProviderOptions);
  const name = textInput(provider.name, 'provider-name');
  name.addEventListener('input', () => { title.textContent = name.value || '(unnamed provider)'; });
  const kind = selectInput(['native_agent', 'builtin_connector', 'external_mcp', 'web_review', 'openai_compatible'], provider.kind, 'provider-kind');
  const enabled = checkbox(provider.enabled, 'provider-enabled');
  const approval = checkbox(provider.requires_user_approval, 'provider-approval');
  const read = checkbox(provider.capabilities?.read, 'provider-read');
  const write = checkbox(provider.capabilities?.write, 'provider-write');
  const background = checkbox(provider.capabilities?.background, 'provider-background');
  const description = textarea(provider.description, 'provider-description');
  const config = textarea(JSON.stringify(provider.config, null, 2), 'provider-config');
  const nativeOptions = document.createElement('div');
  nativeOptions.className = 'grid two provider-native-options';
  const model = textInput(provider.config?.model || '', 'provider-model');
  const currentEffort = provider.config?.reasoning_effort || '';
  const effortOptions = ['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  if (!effortOptions.includes(currentEffort)) effortOptions.push(currentEffort);
  const reasoningEffort = selectInput(
    effortOptions,
    currentEffort,
    'provider-reasoning-effort',
  );
  nativeOptions.append(field('Model', model), field('Reasoning effort', reasoningEffort));

  const syncNativeVisibility = () => {
    nativeOptions.hidden = kind.value !== 'native_agent';
  };
  const syncNativeConfig = () => {
    if (kind.value !== 'native_agent') return;
    let parsed;
    try { parsed = JSON.parse(config.value); } catch { return; }
    parsed.model = model.value.trim();
    parsed.reasoning_effort = reasoningEffort.value;
    config.value = JSON.stringify(parsed, null, 2);
    markDirty();
  };
  const syncNativeFields = () => {
    if (kind.value !== 'native_agent') return;
    try {
      const parsed = JSON.parse(config.value);
      if (typeof parsed.model === 'string') model.value = parsed.model;
      if ([...reasoningEffort.options].some((option) => option.value === parsed.reasoning_effort)) {
        reasoningEffort.value = parsed.reasoning_effort;
      }
    } catch {}
  };
  model.addEventListener('input', syncNativeConfig);
  reasoningEffort.addEventListener('change', syncNativeConfig);
  config.addEventListener('input', syncNativeFields);
  kind.addEventListener('change', syncNativeVisibility);
  syncNativeVisibility();

  const toggles = document.createElement('div');
  toggles.className = 'grid three';
  toggles.append(
    field('Enabled', enabled),
    field('Require task approval', approval),
    field('Read capability', read),
    field('Write capability', write),
    field('Background capability', background),
  );
  body.append(
    grid(field('Provider id', id), field('Display name', name)),
    grid(field('Kind', kind), document.createElement('span')),
    toggles,
    field('Description', description),
    nativeOptions,
    field('Provider adapter JSON (never store secret values)', config),
  );

  const actions = document.createElement('div');
  actions.className = 'actions';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'danger small';
  remove.textContent = 'Remove provider';
  remove.addEventListener('click', () => {
    details.remove();
    markDirty();
    refreshProviderOptions();
  });
  actions.append(remove);
  body.append(actions);
  details.append(summary, body);
  return details;
}

const ROUTE_STAGES = {
  solo: [],
  delegate: [{ id: 'implementation', role: 'implementer' }],
  audit: [{ id: 'review', role: 'reviewer' }],
  full: [{ id: 'implementation', role: 'implementer' }, { id: 'review', role: 'reviewer' }],
};

function stageEditor(stage) {
  const section = document.createElement('section');
  section.className = 'stage-card';
  section.dataset.stageId = stage.id;
  section.dataset.role = stage.role;
  const heading = document.createElement('h3');
  heading.textContent = `${stage.role === 'implementer' ? 'Implementation' : 'Review'} stage`;
  const provider = document.createElement('select');
  provider.className = 'stage-provider';
  provider.dataset.current = stage.provider_id || '';
  provider.addEventListener('change', markDirty);
  const access = selectInput(['read_only', 'bounded_write'], stage.access || 'read_only', 'stage-access');
  const approval = checkbox(stage.requires_user_approval, 'stage-approval');
  const template = textarea(stage.template || 'Perform {{task}} under {{constraints}}. Verify with {{verification}}.', 'stage-template template');
  access.addEventListener('change', refreshProviderOptions);
  section.append(
    heading,
    grid(field('Pinned provider', provider), field('Access', access)),
    field('Require task approval', approval),
    field('Private stage prompt template', template),
  );
  return section;
}

function currentStages(card) {
  return $$('.stage-card', card).map((stage) => ({
    id: stage.dataset.stageId,
    role: stage.dataset.role,
    provider_id: $('.stage-provider', stage).value,
    access: $('.stage-access', stage).value,
    requires_user_approval: $('.stage-approval', stage).checked,
    template: $('.stage-template', stage).value,
  }));
}

function taskTypeFromCard(card) {
  return {
    id: $('.task-type-id', card).value.trim(),
    name: $('.task-type-name', card).value.trim(),
    enabled: $('.task-type-enabled', card).checked,
    description: $('.task-type-description', card).value,
    route: $('.task-type-route', card).value,
    tags: $('.task-type-tags', card).value.split(',').map((value) => value.trim()).filter(Boolean),
    stages: currentStages(card),
  };
}

function uniqueTaskTypeId(baseId) {
  const ids = new Set($$('.task-type-id').map((input) => input.value.trim()).filter(Boolean));
  if (!ids.has(baseId)) return baseId;
  let suffix = 2;
  while (ids.has(`${baseId}-${suffix}`)) suffix += 1;
  return `${baseId}-${suffix}`;
}

function appendTaskType(taskType) {
  const card = taskTypeCard(taskType, $$('.task-type-card').length);
  $('#task-types').append(card);
  card.open = true;
  markDirty();
  refreshProviderOptions();
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderPresetOptions() {
  const select = $('#task-type-preset');
  select.replaceChildren();
  for (const taskType of state.bundledDefaults?.task_types || []) {
    const option = document.createElement('option');
    option.value = taskType.id;
    option.textContent = `${taskType.name} · ${taskType.route}`;
    select.append(option);
  }
}

function renderStages(card, route, previous = []) {
  const stages = ROUTE_STAGES[route].map((shape) => previous.find((stage) => stage.id === shape.id) || {
    ...shape,
    provider_id: $('.provider-id')?.value || '',
    access: shape.role === 'reviewer' ? 'read_only' : 'bounded_write',
    requires_user_approval: shape.role === 'implementer',
    template: shape.role === 'reviewer'
      ? 'Review {{task}} using {{context}}. Respect {{constraints}} and verify against {{verification}}.'
      : 'Perform {{task}} using {{context}}. Respect {{constraints}} and verify with {{verification}}.',
  });
  $('.task-stages', card).replaceChildren(...stages.map(stageEditor));
  refreshProviderOptions();
}

function taskTypeCard(taskType, index) {
  const details = document.createElement('details');
  details.className = 'card task-type-card';
  details.dataset.index = String(index);
  const summary = document.createElement('summary');
  const title = document.createElement('span');
  title.textContent = taskType.name;
  const meta = document.createElement('span');
  meta.className = 'card-meta';
  meta.textContent = `${taskType.route} · ${taskType.stages.length} stage(s)`;
  summary.append(title, meta);

  const body = document.createElement('div');
  body.className = 'card-body';
  const id = textInput(taskType.id, 'task-type-id');
  const name = textInput(taskType.name, 'task-type-name');
  name.addEventListener('input', () => { title.textContent = name.value || '(unnamed task type)'; });
  const enabled = checkbox(taskType.enabled, 'task-type-enabled');
  const route = selectInput(['solo', 'delegate', 'audit', 'full'], taskType.route, 'task-type-route');
  const description = textarea(taskType.description, 'task-type-description');
  const tags = textInput((taskType.tags || []).join(', '), 'task-type-tags');
  const stageContainer = document.createElement('div');
  stageContainer.className = 'task-stages stack';
  route.addEventListener('change', () => {
    const previous = currentStages(details);
    renderStages(details, route.value, previous);
    meta.textContent = `${route.value} · ${ROUTE_STAGES[route.value].length} stage(s)`;
  });

  const toggles = document.createElement('div');
  toggles.className = 'grid three';
  toggles.append(
    field('Enabled', enabled),
  );
  body.append(
    grid(field('Task Type id', id), field('Display name', name)),
    grid(field('Route', route), document.createElement('span')),
    toggles,
    field('Description visible to Sol', description),
    field('Tags (comma separated)', tags),
    stageContainer,
  );
  const actions = document.createElement('div');
  actions.className = 'actions';
  const duplicate = document.createElement('button');
  duplicate.type = 'button';
  duplicate.className = 'secondary small duplicate-task-type';
  duplicate.textContent = 'Duplicate Task Type';
  duplicate.addEventListener('click', () => {
    const copy = structuredClone(taskTypeFromCard(details));
    copy.id = uniqueTaskTypeId(`${copy.id || 'custom-task-type'}-copy`);
    copy.name = `${copy.name || 'Custom Task Type'} copy`;
    copy.enabled = false;
    appendTaskType(copy);
  });
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'danger small';
  remove.textContent = 'Remove Task Type';
  remove.addEventListener('click', () => { details.remove(); markDirty(); });
  actions.append(duplicate, remove);
  body.append(actions);
  details.append(summary, body);
  renderStages(details, taskType.route, taskType.stages);
  return details;
}

function refreshProviderOptions() {
  const providers = $$('.provider-card').map((card) => ({
    id: $('.provider-id', card).value.trim(),
    name: $('.provider-name', card).value.trim(),
    read: $('.provider-read', card).checked,
    write: $('.provider-write', card).checked,
  })).filter((provider) => provider.id);
  for (const select of $$('.stage-provider')) {
    const current = select.value || select.dataset.current || '';
    const access = $('.stage-access', select.closest('.stage-card'))?.value || 'read_only';
    const compatible = providers.filter((provider) => provider.read && (access !== 'bounded_write' || provider.write));
    select.replaceChildren();
    for (const provider of compatible) {
      const option = document.createElement('option');
      option.value = provider.id;
      option.textContent = `${provider.name || '(unnamed)'} · ${provider.id}`;
      option.selected = provider.id === current;
      select.append(option);
    }
    if (!compatible.some((provider) => provider.id === current) && current) {
      const option = document.createElement('option');
      option.value = current;
      option.textContent = `${current} (missing or incompatible)`;
      option.selected = true;
      select.prepend(option);
    }
  }
}

function render() {
  const config = state.config;
  $('#page-title').textContent = config.global.console_title || 'Sol Subagent Control';
  $('#global-enabled').checked = config.global.enabled;
  $('#allow-direct-api').checked = config.global.allow_direct_api;
  $('#console-title').value = config.global.console_title;
  $('#providers').replaceChildren(...config.providers.map(providerCard));
  $('#task-types').replaceChildren(...config.task_types.map(taskTypeCard));
  renderPresetOptions();
  refreshProviderOptions();
  state.dirty = false;
  setBadge('Loaded', 'ok');
}

function collect() {
  const providers = $$('.provider-card').map((card) => {
    let config;
    try {
      config = JSON.parse($('.provider-config', card).value);
    } catch (error) {
      throw new Error(`Provider ${$('.provider-id', card).value || '(unknown)'} adapter JSON is invalid: ${error.message}`);
    }
    if ($('.provider-kind', card).value === 'native_agent') {
      config.model = $('.provider-model', card).value.trim();
      config.reasoning_effort = $('.provider-reasoning-effort', card).value;
    }
    return {
      id: $('.provider-id', card).value.trim(),
      name: $('.provider-name', card).value.trim(),
      kind: $('.provider-kind', card).value,
      enabled: $('.provider-enabled', card).checked,
      description: $('.provider-description', card).value,
      requires_user_approval: $('.provider-approval', card).checked,
      capabilities: {
        read: $('.provider-read', card).checked,
        write: $('.provider-write', card).checked,
        background: $('.provider-background', card).checked,
      },
      config,
    };
  });
  const taskTypes = $$('.task-type-card').map(taskTypeFromCard);
  return {
    version: state.config.version,
    global: {
      ...state.config.global,
      enabled: $('#global-enabled').checked,
      allow_direct_api: $('#allow-direct-api').checked,
      console_title: $('#console-title').value.trim(),
    },
    providers,
    task_types: taskTypes,
  };
}

async function load(path = '/api/config') {
  setBadge('Loading');
  const [payload, defaultsPayload] = await Promise.all([
    api(path),
    state.bundledDefaults ? Promise.resolve(null) : api('/api/defaults'),
  ]);
  if (defaultsPayload) state.bundledDefaults = defaultsPayload.config;
  state.config = payload.config;
  if (path === '/api/config') {
    state.revision = payload.revision;
    state.storage = payload.storage;
    const global = state.storage?.scope === 'global';
    $('#config-storage').classList.toggle('override', !global);
    $('#config-storage-scope').textContent = global
      ? 'Global user configuration — shared by every project and new task'
      : 'Override/test configuration — not shared globally';
    $('#config-storage-path').textContent = state.storage?.config_path || 'Unknown path';
  }
  render();
}

async function save() {
  setBadge('Saving');
  const payload = await api('/api/config', {
    method: 'PUT',
    body: JSON.stringify({ config: collect(), expected_revision: state.revision }),
  });
  state.config = payload.config;
  state.revision = payload.revision;
  render();
  toast('Configuration saved. New resolutions will use it immediately.');
}

$('#save').addEventListener('click', () => save().catch((error) => { setBadge('Error', 'error'); toast(error.message, true); }));
$('#reload').addEventListener('click', () => {
  if (state.dirty && !confirm('Discard unsaved changes and reload?')) return;
  load().catch((error) => { setBadge('Error', 'error'); toast(error.message, true); });
});
$('#load-defaults').addEventListener('click', () => {
  if (!confirm('Load bundled defaults into the editor? They are not saved yet.')) return;
  api('/api/defaults').then((payload) => {
    state.bundledDefaults = payload.config;
    state.config = payload.config;
    render();
    markDirty();
    toast('Bundled defaults loaded. Press Save configuration to apply them.');
  }).catch((error) => toast(error.message, true));
});
$('#add-provider').addEventListener('click', () => {
  const n = $$('.provider-card').length + 1;
  const provider = {
    id: `custom-provider-${n}`,
    name: `Custom provider ${n}`,
    kind: 'openai_compatible',
    enabled: false,
    description: '',
    requires_user_approval: true,
    capabilities: { read: true, write: false, background: false },
    config: {
      endpoint: 'https://example.invalid/v1/chat/completions',
      model: 'replace-me',
      api_key_env: 'SOL_CONTROL_CUSTOM_API_KEY',
      auth_type: 'bearer',
      timeout_ms: 120000,
      max_output_tokens: 4096,
      max_tokens_field: 'max_tokens',
      temperature: 0.2,
      system_prompt: 'You are an advisory subagent. Return text only.',
      headers: {},
    },
  };
  $('#providers').append(providerCard(provider, n - 1));
  markDirty();
  refreshProviderOptions();
});
$('#add-task-type-from-preset').addEventListener('click', () => {
  const source = state.bundledDefaults?.task_types.find((taskType) => taskType.id === $('#task-type-preset').value);
  if (!source) {
    toast('No bundled Task Type preset is available.', true);
    return;
  }
  const taskType = structuredClone(source);
  const originalId = taskType.id;
  taskType.id = uniqueTaskTypeId(originalId);
  if (taskType.id !== originalId) {
    taskType.name = `${taskType.name} copy`;
    taskType.enabled = false;
  }
  appendTaskType(taskType);
});
$('#add-task-type').addEventListener('click', () => {
  const n = $$('.task-type-card').length + 1;
  const firstProvider = $('.provider-id')?.value || '';
  const taskType = {
    id: `custom-task-type-${n}`,
    name: `Custom Task Type ${n}`,
    enabled: false,
    description: '',
    route: 'delegate',
    tags: ['custom'],
    stages: [{
      id: 'implementation', role: 'implementer', provider_id: firstProvider,
      access: 'read_only', requires_user_approval: true,
      template: 'TASK\n{{task}}\n\nCONTEXT\n{{context}}\n\nCONSTRAINTS\n{{constraints}}\n\nVERIFICATION\n{{verification}}',
    }],
  };
  taskType.id = uniqueTaskTypeId(taskType.id);
  appendTaskType(taskType);
});
for (const selector of ['#global-enabled', '#allow-direct-api', '#console-title']) {
  $(selector).addEventListener('change', markDirty);
  $(selector).addEventListener('input', markDirty);
}
window.addEventListener('beforeunload', (event) => {
  if (!state.dirty) return;
  event.preventDefault();
  event.returnValue = '';
});

load().catch((error) => {
  setBadge('Unavailable', 'error');
  toast(error.message, true);
});
