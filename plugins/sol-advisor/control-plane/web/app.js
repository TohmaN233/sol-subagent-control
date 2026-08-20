const fragment = new URLSearchParams(location.hash.slice(1));
const token = fragment.get('token') || '';
history.replaceState(null, '', location.pathname);

const state = { config: null, revision: '', dirty: false };
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
  const kind = selectInput(['native_agent', 'mcp_tool', 'web_review', 'openai_compatible'], provider.kind, 'provider-kind');
  const enabled = checkbox(provider.enabled, 'provider-enabled');
  const approval = checkbox(provider.requires_user_approval, 'provider-approval');
  const read = checkbox(provider.capabilities?.read, 'provider-read');
  const write = checkbox(provider.capabilities?.write, 'provider-write');
  const background = checkbox(provider.capabilities?.background, 'provider-background');
  const description = textarea(provider.description, 'provider-description');
  const config = textarea(JSON.stringify(provider.config, null, 2), 'provider-config');

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

function scenarioCard(scenario, index) {
  const details = document.createElement('details');
  details.className = 'card scenario-card';
  details.dataset.index = String(index);
  const summary = document.createElement('summary');
  const title = document.createElement('span');
  title.textContent = scenario.name;
  const meta = document.createElement('span');
  meta.className = 'card-meta';
  meta.textContent = `${scenario.route} · ${scenario.provider_id}`;
  summary.append(title, meta);

  const body = document.createElement('div');
  body.className = 'card-body';
  const id = textInput(scenario.id, 'scenario-id');
  const name = textInput(scenario.name, 'scenario-name');
  name.addEventListener('input', () => { title.textContent = name.value || '(unnamed scenario)'; });
  const enabled = checkbox(scenario.enabled, 'scenario-enabled');
  const route = selectInput(['solo', 'delegate', 'audit', 'full'], scenario.route, 'scenario-route');
  const provider = document.createElement('select');
  provider.className = 'scenario-provider';
  provider.dataset.current = scenario.provider_id;
  provider.addEventListener('change', () => {
    provider.dataset.current = provider.value;
    meta.textContent = `${route.value} · ${provider.value}`;
    markDirty();
  });
  route.addEventListener('change', () => { meta.textContent = `${route.value} · ${provider.value}`; });
  const readOnly = checkbox(scenario.read_only, 'scenario-read-only');
  const approval = checkbox(scenario.requires_user_approval, 'scenario-approval');
  const description = textarea(scenario.description, 'scenario-description');
  const tags = textInput((scenario.tags || []).join(', '), 'scenario-tags');
  const template = textarea(scenario.template, 'scenario-template template');

  const toggles = document.createElement('div');
  toggles.className = 'grid three';
  toggles.append(
    field('Enabled', enabled),
    field('Read-only', readOnly),
    field('Require task approval', approval),
  );
  body.append(
    grid(field('Scenario id', id), field('Display name', name)),
    grid(field('Route', route), field('Provider mapping', provider)),
    toggles,
    field('Description visible to Sol', description),
    field('Tags (comma separated)', tags),
    field('Private prompt template', template),
  );
  const actions = document.createElement('div');
  actions.className = 'actions';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'danger small';
  remove.textContent = 'Remove scenario';
  remove.addEventListener('click', () => { details.remove(); markDirty(); });
  actions.append(remove);
  body.append(actions);
  details.append(summary, body);
  return details;
}

function refreshProviderOptions() {
  const ids = $$('.provider-id').map((input) => input.value.trim()).filter(Boolean);
  for (const select of $$('.scenario-provider')) {
    const current = select.value || select.dataset.current || '';
    select.replaceChildren();
    for (const id of ids) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = id;
      option.selected = id === current;
      select.append(option);
    }
    if (!ids.includes(current) && current) {
      const option = document.createElement('option');
      option.value = current;
      option.textContent = `${current} (missing)`;
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
  $('#scenarios').replaceChildren(...config.scenarios.map(scenarioCard));
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
  const scenarios = $$('.scenario-card').map((card) => ({
    id: $('.scenario-id', card).value.trim(),
    name: $('.scenario-name', card).value.trim(),
    enabled: $('.scenario-enabled', card).checked,
    description: $('.scenario-description', card).value,
    route: $('.scenario-route', card).value,
    provider_id: $('.scenario-provider', card).value,
    read_only: $('.scenario-read-only', card).checked,
    requires_user_approval: $('.scenario-approval', card).checked,
    tags: $('.scenario-tags', card).value.split(',').map((value) => value.trim()).filter(Boolean),
    template: $('.scenario-template', card).value,
  }));
  return {
    version: 1,
    global: {
      ...state.config.global,
      enabled: $('#global-enabled').checked,
      allow_direct_api: $('#allow-direct-api').checked,
      console_title: $('#console-title').value.trim(),
    },
    providers,
    scenarios,
  };
}

async function load(path = '/api/config') {
  setBadge('Loading');
  const payload = await api(path);
  state.config = payload.config;
  state.revision = path === '/api/config' ? payload.revision : state.revision;
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
$('#add-scenario').addEventListener('click', () => {
  const n = $$('.scenario-card').length + 1;
  const firstProvider = $('.provider-id')?.value || '';
  const scenario = {
    id: `custom-scenario-${n}`,
    name: `Custom scenario ${n}`,
    enabled: false,
    description: '',
    route: 'delegate',
    provider_id: firstProvider,
    read_only: true,
    requires_user_approval: true,
    tags: ['custom'],
    template: 'ROLE\nAct as {{provider_name}}.\n\nTASK\n{{task}}\n\nCONTEXT\n{{context}}\n\nCONSTRAINTS\n{{constraints}}\n\nVERIFICATION\n{{verification}}',
  };
  $('#scenarios').append(scenarioCard(scenario, n - 1));
  markDirty();
  refreshProviderOptions();
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
