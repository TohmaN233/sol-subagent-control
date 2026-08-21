import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, lstat, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const CONFIG_VERSION = 2;
export const PROVIDER_KINDS = new Set(['native_agent', 'builtin_connector', 'external_mcp', 'mcp_tool', 'web_review', 'openai_compatible']);
export const ROUTES = new Set(['solo', 'delegate', 'audit', 'full']);
export const ALLOWED_TEMPLATE_FIELDS = new Set([
  'task', 'context', 'constraints', 'verification', 'scenario_id', 'provider_name',
]);

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ENV_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;
const SECRET_RE = /(authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|token|secret|password)/i;
const MAX_CONFIG_BYTES = 512 * 1024;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value, field, { required = false, max = 20_000 } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${field} is required`);
    return '';
  }
  assert(typeof value === 'string', `${field} must be a string`);
  const result = value.trim();
  if (required) assert(result.length > 0, `${field} must not be empty`);
  assert(result.length <= max, `${field} exceeds ${max} characters`);
  return result;
}

function bool(value, fallback = false) {
  if (value === undefined) return fallback;
  assert(typeof value === 'boolean', 'expected boolean');
  return value;
}

function integer(value, fallback, min, max, field) {
  if (value === undefined) return fallback;
  assert(Number.isInteger(value) && value >= min && value <= max,
    `${field} must be an integer between ${min} and ${max}`);
  return value;
}

function id(value, field) {
  const result = text(value, field, { required: true, max: 64 });
  assert(ID_RE.test(result), `${field} must match ${ID_RE}`);
  return result;
}

function jsonClone(value, field) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    throw new Error(`${field} must be JSON-serializable: ${error.message}`);
  }
}

function rejectSecretKeys(value, path = 'provider.config') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSecretKeys(item, `${path}[${index}]`));
    return;
  }
  if (!object(value)) return;
  for (const [key, child] of Object.entries(value)) {
    assert(!SECRET_RE.test(key), `${path}.${key} looks like a stored secret; use an environment-variable name instead`);
    rejectSecretKeys(child, `${path}.${key}`);
  }
}

export function isEnvironmentDisabled(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env.SOL_CONTROL_DISABLED || '').trim());
}

export function resolveConfigPath(env = process.env, userHome = homedir()) {
  if (env.SOL_CONTROL_CONFIG) {
    assert(isAbsolute(env.SOL_CONTROL_CONFIG), 'SOL_CONTROL_CONFIG must be an absolute path');
    return resolve(env.SOL_CONTROL_CONFIG);
  }
  const codexHome = env.CODEX_HOME
    ? (isAbsolute(env.CODEX_HOME) ? resolve(env.CODEX_HOME) : resolve(userHome, env.CODEX_HOME))
    : join(userHome, '.codex');
  return join(codexHome, 'sol-advisor', 'control-plane.json');
}

export function resolveAuditPath(configPath) {
  return join(dirname(configPath), 'control-plane-audit.jsonl');
}

export function validateEndpoint(value) {
  let endpoint;
  try {
    endpoint = new URL(text(value, 'provider.config.endpoint', { required: true, max: 2048 }));
  } catch (error) {
    throw new Error(`provider.config.endpoint is not a valid URL: ${error.message}`);
  }
  assert(!endpoint.username && !endpoint.password, 'provider endpoint must not contain credentials');
  assert(!endpoint.search && !endpoint.hash, 'provider endpoint must not contain a query or fragment');
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(endpoint.hostname);
  assert(endpoint.protocol === 'https:' || (endpoint.protocol === 'http:' && loopback),
    'provider endpoint must use HTTPS, except HTTP loopback endpoints');
  return endpoint.toString();
}

function capabilities(raw, kind) {
  const value = object(raw) ? raw : {};
  return {
    read: bool(value.read, true),
    write: bool(value.write, kind === 'native_agent' || kind === 'external_mcp' || kind === 'mcp_tool'),
    background: bool(value.background, kind === 'builtin_connector' || kind === 'external_mcp' || kind === 'mcp_tool'),
  };
}

function validateNative(raw) {
  assert(object(raw), 'native provider config must be an object');
  const role = text(raw.role, 'provider.config.role', { required: true, max: 32 });
  assert(['implementer', 'reviewer', 'advisor'].includes(role),
    'native provider role must be implementer, reviewer, or advisor');
  return {
    agent_type: text(raw.agent_type, 'provider.config.agent_type', { required: true, max: 128 }),
    model: text(raw.model, 'provider.config.model', { required: true, max: 128 }),
    reasoning_effort: text(raw.reasoning_effort, 'provider.config.reasoning_effort', { required: true, max: 32 }),
    role,
    fresh_context: bool(raw.fresh_context, true),
    requested_sandbox: text(raw.requested_sandbox, 'provider.config.requested_sandbox', { max: 64 }),
  };
}

function validateBuiltinConnector(raw) {
  assert(object(raw), 'built-in connector config must be an object');
  rejectSecretKeys(raw);
  const connector = text(raw.connector, 'provider.config.connector', { required: true, max: 64 });
  assert(['grok_acp', 'cursor_cdp'].includes(connector),
    'provider.config.connector must be grok_acp or cursor_cdp');
  const common = {
    connector,
    environment_mode: 'inherit',
    startup_timeout_ms: integer(raw.startup_timeout_ms, 15_000, 1_000, 120_000,
      'provider.config.startup_timeout_ms'),
    task_timeout_ms: integer(raw.task_timeout_ms, 600_000, 1_000, 900_000,
      'provider.config.task_timeout_ms'),
    max_result_chars: integer(raw.max_result_chars, 131_072, 1_024, 524_288,
      'provider.config.max_result_chars'),
    single_active_run: true,
  };
  if (connector === 'grok_acp') {
    const binaryEnv = text(raw.binary_env ?? 'GROK_BIN',
      'provider.config.binary_env', { required: true, max: 128 });
    assert(ENV_RE.test(binaryEnv),
      'provider.config.binary_env must name an uppercase environment variable');
    const transport = text(raw.transport ?? 'leader_acp_stdio',
      'provider.config.transport', { required: true, max: 64 });
    assert(transport === 'leader_acp_stdio',
      'provider.config.transport must be leader_acp_stdio for grok_acp');
    return { ...common, binary_env: binaryEnv, transport };
  }
  const executableEnv = text(raw.executable_env ?? 'CURSOR_EXE',
    'provider.config.executable_env', { required: true, max: 128 });
  assert(ENV_RE.test(executableEnv),
    'provider.config.executable_env must name an uppercase environment variable');
  const transport = text(raw.transport ?? 'cdp_ui',
    'provider.config.transport', { required: true, max: 64 });
  assert(transport === 'cdp_ui',
    'provider.config.transport must be cdp_ui for cursor_cdp');
  const uiProfile = text(raw.ui_profile ?? 'agents_v2_2026_08',
    'provider.config.ui_profile', { required: true, max: 64 });
  assert(uiProfile === 'agents_v2_2026_08',
    'provider.config.ui_profile must be agents_v2_2026_08 in this release');
  return {
    ...common,
    executable_env: executableEnv,
    transport,
    cdp_port: integer(raw.cdp_port, 9223, 1024, 65535, 'provider.config.cdp_port'),
    command_timeout_ms: integer(raw.command_timeout_ms, 30_000, 1_000, 120_000,
      'provider.config.command_timeout_ms'),
    launch_if_closed: bool(raw.launch_if_closed, true),
    ui_profile: uiProfile,
  };
}

function validateMcp(raw) {
  assert(object(raw), 'MCP provider config must be an object');
  rejectSecretKeys(raw);
  assert(object(raw.tools) && Object.keys(raw.tools).length > 0,
    'MCP provider must declare at least one tool operation');
  const tools = {};
  for (const [operation, toolName] of Object.entries(raw.tools)) {
    tools[id(operation, 'provider.config.tools operation')] = text(
      toolName, `provider.config.tools.${operation}`, { required: true, max: 128 },
    );
  }
  return {
    protocol: text(raw.protocol, 'provider.config.protocol', { required: true, max: 128 }),
    model_label: text(raw.model_label, 'provider.config.model_label', { required: true, max: 128 }),
    tools,
    defaults: object(raw.defaults) ? jsonClone(raw.defaults, 'provider.config.defaults') : {},
    notes: text(raw.notes, 'provider.config.notes', { max: 4000 }),
  };
}

function validateWeb(raw) {
  assert(object(raw), 'web-review provider config must be an object');
  rejectSecretKeys(raw);
  const path = text(raw.path, 'provider.config.path', { required: true, max: 32 });
  assert(path === 'packet', 'web-review provider path must be packet');
  return {
    skill: text(raw.skill, 'provider.config.skill', { required: true, max: 256 }),
    source_repository: text(raw.source_repository, 'provider.config.source_repository', { max: 512 }),
    path,
    reviewer: text(raw.reviewer, 'provider.config.reviewer', { required: true, max: 128 }),
    model_label: text(raw.model_label, 'provider.config.model_label', { required: true, max: 128 }),
  };
}

function validateHeaders(raw) {
  if (raw === undefined) return {};
  assert(object(raw), 'provider.config.headers must be an object');
  const result = {};
  for (const [name, value] of Object.entries(raw)) {
    assert(!SECRET_RE.test(name), `provider.config.headers must not store sensitive header ${name}`);
    result[text(name, 'provider.config.headers name', { required: true, max: 128 })] =
      text(value, `provider.config.headers.${name}`, { required: true, max: 2048 });
  }
  return result;
}

function validateOpenAI(raw) {
  assert(object(raw), 'OpenAI-compatible provider config must be an object');
  const authType = text(raw.auth_type ?? 'bearer', 'provider.config.auth_type', { required: true, max: 32 });
  assert(['bearer', 'x-api-key', 'none'].includes(authType),
    'provider.config.auth_type must be bearer, x-api-key, or none');
  const apiKeyEnv = text(raw.api_key_env, 'provider.config.api_key_env', { max: 128 });
  if (authType !== 'none') {
    assert(ENV_RE.test(apiKeyEnv),
      'provider.config.api_key_env must name an uppercase environment variable');
  }
  const maxTokensField = text(raw.max_tokens_field ?? 'max_tokens',
    'provider.config.max_tokens_field', { required: true, max: 64 });
  assert(['max_tokens', 'max_completion_tokens'].includes(maxTokensField),
    'provider.config.max_tokens_field must be max_tokens or max_completion_tokens');
  const temperature = raw.temperature === undefined ? 0.2 : Number(raw.temperature);
  assert(Number.isFinite(temperature) && temperature >= 0 && temperature <= 2,
    'provider.config.temperature must be between 0 and 2');
  return {
    endpoint: validateEndpoint(raw.endpoint),
    model: text(raw.model, 'provider.config.model', { required: true, max: 256 }),
    api_key_env: apiKeyEnv,
    auth_type: authType,
    timeout_ms: integer(raw.timeout_ms, 120_000, 5_000, 900_000, 'provider.config.timeout_ms'),
    max_output_tokens: integer(raw.max_output_tokens, 4096, 1, 100_000, 'provider.config.max_output_tokens'),
    max_tokens_field: maxTokensField,
    temperature,
    system_prompt: text(raw.system_prompt, 'provider.config.system_prompt', { max: 20_000 }),
    headers: validateHeaders(raw.headers),
  };
}

function validateProvider(raw, index) {
  assert(object(raw), `providers[${index}] must be an object`);
  const kind = text(raw.kind, `providers[${index}].kind`, { required: true, max: 64 });
  assert(PROVIDER_KINDS.has(kind), `providers[${index}].kind is unsupported`);
  const validators = {
    native_agent: validateNative,
    builtin_connector: validateBuiltinConnector,
    external_mcp: validateMcp,
    mcp_tool: validateMcp,
    web_review: validateWeb,
    openai_compatible: validateOpenAI,
  };
  const normalizedKind = kind === 'mcp_tool' ? 'external_mcp' : kind;
  return {
    id: id(raw.id, `providers[${index}].id`),
    name: text(raw.name, `providers[${index}].name`, { required: true, max: 128 }),
    kind: normalizedKind,
    enabled: bool(raw.enabled, false),
    description: text(raw.description, `providers[${index}].description`, { max: 4000 }),
    requires_user_approval: bool(raw.requires_user_approval, kind !== 'native_agent'),
    capabilities: capabilities(raw.capabilities, normalizedKind),
    config: validators[kind](raw.config),
  };
}

function validateTemplate(value, field) {
  const template = text(value, field, { required: true, max: 60_000 });
  assert(template.includes('{{task}}'), `${field} must include {{task}}`);
  for (const match of template.matchAll(/{{\s*([a-zA-Z0-9_]+)\s*}}/g)) {
    assert(ALLOWED_TEMPLATE_FIELDS.has(match[1]),
      `${field} contains unsupported placeholder {{${match[1]}}}`);
  }
  const stripped = template.replace(/{{\s*[a-zA-Z0-9_]+\s*}}/g, '');
  assert(!stripped.includes('{{') && !stripped.includes('}}'),
    `${field} contains malformed template braces`);
  return template;
}

function validateScenario(raw, index) {
  assert(object(raw), `scenarios[${index}] must be an object`);
  const route = text(raw.route, `scenarios[${index}].route`, { required: true, max: 32 });
  assert(ROUTES.has(route), `scenarios[${index}].route is unsupported`);
  return {
    id: id(raw.id, `scenarios[${index}].id`),
    name: text(raw.name, `scenarios[${index}].name`, { required: true, max: 128 }),
    enabled: bool(raw.enabled, true),
    description: text(raw.description, `scenarios[${index}].description`, { max: 4000 }),
    route,
    provider_id: id(raw.provider_id, `scenarios[${index}].provider_id`),
    read_only: bool(raw.read_only, false),
    requires_user_approval: bool(raw.requires_user_approval, false),
    tags: Array.isArray(raw.tags)
      ? raw.tags.map((tag, tagIndex) => text(tag, `scenarios[${index}].tags[${tagIndex}]`, { required: true, max: 64 }))
      : [],
    template: validateTemplate(raw.template, `scenarios[${index}].template`),
  };
}

export function migrateConfigV1(raw, bundledDefaults) {
  assert(object(raw), 'config must be an object');
  assert(raw.version === 1, 'migrateConfigV1 accepts only config.version=1');
  const defaults = validateConfig(bundledDefaults);
  const migrated = jsonClone(raw, 'legacy config');
  migrated.version = CONFIG_VERSION;
  migrated.providers = Array.isArray(migrated.providers) ? migrated.providers : [];
  migrated.scenarios = Array.isArray(migrated.scenarios) ? migrated.scenarios : [];

  const providerIds = new Set(migrated.providers.map((provider) => provider && provider.id));
  for (const providerId of ['cursor-local', 'grok-local']) {
    if (providerIds.has(providerId)) continue;
    const bundled = defaults.providers.find((provider) => provider.id === providerId);
    assert(bundled, `bundled migration provider is missing: ${providerId}`);
    migrated.providers.push(jsonClone(bundled, `bundled provider ${providerId}`));
    providerIds.add(providerId);
  }

  const grok = migrated.providers.find((provider) => provider?.id === 'grok-local');
  if (grok?.kind === 'builtin_connector' && grok?.config?.connector === 'grok_acp') {
    grok.capabilities = object(grok.capabilities) ? grok.capabilities : {};
    grok.capabilities.write = true;
  }

  const scenarioIds = new Set(migrated.scenarios.map((scenario) => scenario && scenario.id));
  for (const scenarioId of ['grok-readonly-advice', 'grok-bounded-change', 'cursor-readonly-advice', 'cursor-bounded-change']) {
    if (scenarioIds.has(scenarioId)) continue;
    const bundled = defaults.scenarios.find((scenario) => scenario.id === scenarioId);
    assert(bundled, `bundled migration scenario is missing: ${scenarioId}`);
    migrated.scenarios.push(jsonClone(bundled, `bundled scenario ${scenarioId}`));
    scenarioIds.add(scenarioId);
  }

  return migrated;
}

export function validateConfig(raw) {
  assert(object(raw), 'config must be an object');
  assert(raw.version === CONFIG_VERSION, `config.version must be ${CONFIG_VERSION}`);
  const providersRaw = Array.isArray(raw.providers) ? raw.providers : [];
  const scenariosRaw = Array.isArray(raw.scenarios) ? raw.scenarios : [];
  assert(providersRaw.length > 0 && providersRaw.length <= 100,
    'config must contain between 1 and 100 providers');
  assert(scenariosRaw.length > 0 && scenariosRaw.length <= 200,
    'config must contain between 1 and 200 scenarios');
  const providers = providersRaw.map(validateProvider);
  const scenarios = scenariosRaw.map(validateScenario);
  const providerIds = new Set();
  for (const provider of providers) {
    assert(!providerIds.has(provider.id), `duplicate provider id: ${provider.id}`);
    providerIds.add(provider.id);
  }
  const scenarioIds = new Set();
  for (const scenario of scenarios) {
    assert(!scenarioIds.has(scenario.id), `duplicate scenario id: ${scenario.id}`);
    scenarioIds.add(scenario.id);
    assert(providerIds.has(scenario.provider_id),
      `scenario ${scenario.id} references missing provider ${scenario.provider_id}`);
  }
  const global = object(raw.global) ? raw.global : {};
  return {
    version: CONFIG_VERSION,
    global: {
      enabled: bool(global.enabled, true),
      allow_direct_api: bool(global.allow_direct_api, false),
      console_title: text(global.console_title ?? 'Sol Subagent Control',
        'global.console_title', { required: true, max: 128 }),
      max_prompt_chars: integer(global.max_prompt_chars, 80_000, 1000, 200_000,
        'global.max_prompt_chars'),
    },
    providers,
    scenarios,
  };
}

async function exists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function assertRegularNoSymlink(path, label) {
  const link = await lstat(path);
  assert(!link.isSymbolicLink(), `${label} must not be a symbolic link`);
  const file = await stat(path);
  assert(file.isFile(), `${label} is not a regular file`);
  return file;
}

export async function ensureConfigFile({ configPath, defaultConfigPath }) {
  if (await exists(configPath)) return;
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  const body = await readFile(defaultConfigPath);
  try {
    await writeFile(configPath, body, { mode: 0o600, flag: 'wx' });
    await chmod(configPath, 0o600).catch(() => {});
  } catch (error) {
    if (error?.code !== 'EEXIST' || !(await exists(configPath))) throw error;
  }
}

async function writeConfigAtomic(validated, configPath) {
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  const temporary = `${configPath}.write-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await chmod(temporary, 0o600).catch(() => {});
  await rename(temporary, configPath);
}

export async function loadConfig({ configPath, defaultConfigPath }) {
  await ensureConfigFile({ configPath, defaultConfigPath });
  const file = await assertRegularNoSymlink(configPath, 'control-plane config path');
  assert(file.size <= MAX_CONFIG_BYTES, `control-plane config exceeds ${MAX_CONFIG_BYTES} bytes`);
  try {
    const raw = JSON.parse(await readFile(configPath, 'utf8'));
    if (raw?.version === 1 && CONFIG_VERSION === 2) {
      const bundled = JSON.parse(await readFile(defaultConfigPath, 'utf8'));
      const migrated = validateConfig(migrateConfigV1(raw, bundled));
      await writeConfigAtomic(migrated, configPath);
      return migrated;
    }
    return validateConfig(raw);
  } catch (error) {
    if (/config|provider|scenario|control-plane|migration/.test(error.message)) throw error;
    throw new Error(`control-plane config is invalid JSON: ${error.message}`);
  }
}

export function configRevision(config) {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

export async function saveConfig(config, { configPath, expectedRevision = '' } = {}) {
  const validated = validateConfig(config);
  if (await exists(configPath)) await assertRegularNoSymlink(configPath, 'control-plane config path');
  if (expectedRevision) {
    const current = validateConfig(JSON.parse(await readFile(configPath, 'utf8')));
    assert(configRevision(current) === expectedRevision,
      'configuration changed since it was loaded');
  }
  await writeConfigAtomic(validated, configPath);
  return { config: validated, revision: configRevision(validated) };
}

function modelLabel(provider) {
  if (provider.kind === 'native_agent') return provider.config.model;
  if (provider.kind === 'openai_compatible') return provider.config.model;
  if (provider.kind === 'builtin_connector' && provider.config.connector === 'grok_acp') {
    return 'Grok Build via ACP (user installation)';
  }
  if (provider.kind === 'builtin_connector' && provider.config.connector === 'cursor_cdp') {
    return 'Cursor user-selected model via local CDP';
  }
  return provider.config.model_label || null;
}

export function sanitizeConfig(config, { env = process.env } = {}) {
  const environmentDisabled = isEnvironmentDisabled(env);
  const providerMap = new Map(config.providers.map((provider) => [provider.id, provider]));
  return {
    version: config.version,
    effective_enabled: config.global.enabled && !environmentDisabled,
    environment_disabled: environmentDisabled,
    global: {
      enabled: config.global.enabled,
      allow_direct_api: config.global.allow_direct_api,
      console_title: config.global.console_title,
    },
    providers: config.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      kind: provider.kind,
      enabled: provider.enabled,
      effective_enabled: provider.enabled && config.global.enabled && !environmentDisabled,
      description: provider.description,
      requires_user_approval: provider.requires_user_approval,
      capabilities: provider.capabilities,
      model_label: modelLabel(provider),
    })),
    scenarios: config.scenarios.map((scenario) => {
      const provider = providerMap.get(scenario.provider_id);
      return {
        id: scenario.id,
        name: scenario.name,
        enabled: scenario.enabled,
        effective_enabled: Boolean(
          scenario.enabled && provider?.enabled && config.global.enabled && !environmentDisabled,
        ),
        description: scenario.description,
        route: scenario.route,
        provider_id: scenario.provider_id,
        provider_kind: provider?.kind || 'missing',
        read_only: scenario.read_only,
        requires_user_approval: Boolean(
          scenario.requires_user_approval || provider?.requires_user_approval || !scenario.read_only,
        ),
        tags: scenario.tags,
        template_revision: createHash('sha256').update(scenario.template).digest('hex').slice(0, 12),
      };
    }),
  };
}

export function findScenario(config, scenarioId) {
  return config.scenarios.find((scenario) => scenario.id === scenarioId) || null;
}

export function findProvider(config, providerId) {
  return config.providers.find((provider) => provider.id === providerId) || null;
}

export async function appendAuditEvent(configPath, event) {
  const safe = {
    at: new Date().toISOString(),
    event: text(event.event, 'audit.event', { required: true, max: 64 }),
    scenario_id: event.scenario_id ? id(event.scenario_id, 'audit.scenario_id') : null,
    provider_id: event.provider_id ? id(event.provider_id, 'audit.provider_id') : null,
    outcome: text(event.outcome ?? 'ok', 'audit.outcome', { required: true, max: 64 }),
    detail: text(event.detail, 'audit.detail', { max: 1000 }),
    task_id: event.task_id ? id(event.task_id, 'audit.task_id') : null,
    action: text(event.action, 'audit.action', { max: 64 }),
    connector: text(event.connector, 'audit.connector', { max: 64 }),
    state: text(event.state, 'audit.state', { max: 64 }),
    error_code: text(event.error_code, 'audit.error_code', { max: 128 }),
  };
  const auditPath = resolveAuditPath(configPath);
  await mkdir(dirname(auditPath), { recursive: true, mode: 0o700 });
  if (await exists(auditPath)) await assertRegularNoSymlink(auditPath, 'control-plane audit path');
  await writeFile(auditPath, `${JSON.stringify(safe)}\n`,
    { encoding: 'utf8', mode: 0o600, flag: 'a' });
  await chmod(auditPath, 0o600).catch(() => {});
}
