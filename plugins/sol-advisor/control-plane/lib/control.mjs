import {
  appendAuditEvent,
  findProvider,
  findScenario,
  isEnvironmentDisabled,
  loadConfig,
  sanitizeConfig,
} from './config.mjs';
import { buildProviderAdapter, invokeOpenAICompatible } from './providers.mjs';
import { renderTemplate } from './templates.mjs';
import { connectorRegistryFor } from '../connectors/registry.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizeApproval(value) {
  return value === true;
}

export async function getControlStatus({ configPath, defaultConfigPath, env = process.env }) {
  const config = await loadConfig({ configPath, defaultConfigPath });
  return sanitizeConfig(config, { env });
}

export async function resolveSelection(args, {
  configPath,
  defaultConfigPath,
  env = process.env,
  audit = true,
} = {}) {
  const config = await loadConfig({ configPath, defaultConfigPath });
  assert(!isEnvironmentDisabled(env), 'Sol control plane is disabled by SOL_CONTROL_DISABLED');
  assert(config.global.enabled, 'Sol control plane is disabled in the user configuration');

  const scenarioId = String(args?.scenario_id || '').trim();
  const task = String(args?.task || '').trim();
  assert(scenarioId, 'scenario_id is required');
  assert(task, 'task is required');

  const scenario = findScenario(config, scenarioId);
  assert(scenario, `unknown scenario: ${scenarioId}`);
  assert(scenario.enabled, `scenario is disabled: ${scenarioId}`);
  const provider = findProvider(config, scenario.provider_id);
  assert(provider, `scenario provider is missing: ${scenario.provider_id}`);
  assert(provider.enabled, `provider is disabled: ${provider.id}`);

  const approvalRequired = Boolean(
    scenario.requires_user_approval || provider.requires_user_approval,
  );
  if (approvalRequired) {
    assert(normalizeApproval(args.user_approved),
      `scenario ${scenario.id} requires explicit current-task user approval`);
  }

  if (!scenario.read_only) {
    assert(provider.capabilities.write,
      `provider ${provider.id} is not configured for write-capable work`);
  }
  assert(provider.capabilities.read, `provider ${provider.id} cannot read task context`);

  const compiledPrompt = renderTemplate(scenario.template, {
    task,
    context: args.context,
    constraints: args.constraints,
    verification: args.verification,
    scenario_id: scenario.id,
    provider_name: provider.name,
  }, config.global.max_prompt_chars);

  const adapter = buildProviderAdapter(provider, scenario, {
    env,
    allowDirectApi: config.global.allow_direct_api,
  });
  const result = {
    scenario: {
      id: scenario.id,
      name: scenario.name,
      route: scenario.route,
      read_only: scenario.read_only,
      tags: scenario.tags,
    },
    provider: {
      id: provider.id,
      name: provider.name,
      kind: provider.kind,
    },
    approval_required: approvalRequired,
    adapter,
    ...(provider.kind === 'builtin_connector'
      ? { prompt_delivery: 'internal', next_operation: 'sol_connector_start' }
      : { compiled_prompt: compiledPrompt }),
  };

  if (audit) {
    await appendAuditEvent(configPath, {
      event: 'resolve',
      scenario_id: scenario.id,
      provider_id: provider.id,
      outcome: 'ok',
    }).catch(() => {});
  }
  return { result, config, scenario, provider, compiledPrompt };
}

export async function invokeSelection(args, {
  configPath,
  defaultConfigPath,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const resolved = await resolveSelection(args, {
    configPath,
    defaultConfigPath,
    env,
    audit: false,
  });
  const { config, scenario, provider, result } = resolved;
  assert(provider.kind === 'openai_compatible',
    'sol_control_invoke supports only openai_compatible providers; native and MCP providers must be executed by Codex through their returned adapter contract');
  assert(config.global.allow_direct_api,
    'direct API invocation is disabled in the user configuration');
  assert(scenario.read_only,
    'direct API providers are advisory-only and require a read-only scenario');

  try {
    const invocation = await invokeOpenAICompatible(provider, result.compiled_prompt, {
      env,
      fetchImpl,
    });
    await appendAuditEvent(configPath, {
      event: 'invoke',
      scenario_id: scenario.id,
      provider_id: provider.id,
      outcome: 'ok',
    }).catch(() => {});
    return {
      scenario: result.scenario,
      provider: result.provider,
      advisory_only: true,
      response: invocation,
    };
  } catch (error) {
    await appendAuditEvent(configPath, {
      event: 'invoke',
      scenario_id: scenario.id,
      provider_id: provider.id,
      outcome: 'error',
      detail: error.message,
    }).catch(() => {});
    throw error;
  }
}


export async function probeConnector(args, {
  configPath,
  defaultConfigPath,
  env = process.env,
  registry = connectorRegistryFor({ configPath, env }),
} = {}) {
  const config = await loadConfig({ configPath, defaultConfigPath });
  assert(!isEnvironmentDisabled(env), 'Sol control plane is disabled by SOL_CONTROL_DISABLED');
  assert(config.global.enabled, 'Sol control plane is disabled in the user configuration');
  const providerId = String(args?.provider_id || '').trim();
  assert(providerId, 'provider_id is required');
  const provider = findProvider(config, providerId);
  assert(provider, `unknown provider: ${providerId}`);
  assert(provider.enabled, `provider is disabled: ${providerId}`);
  assert(provider.kind === 'builtin_connector', `provider is not a built-in connector: ${providerId}`);
  return registry.probe(provider, { workspace: args?.workspace });
}

export async function startConnectorSelection(args, {
  configPath,
  defaultConfigPath,
  env = process.env,
  registry = connectorRegistryFor({ configPath, env }),
} = {}) {
  const resolved = await resolveSelection(args, {
    configPath, defaultConfigPath, env, audit: false,
  });
  const { config, scenario, provider, compiledPrompt } = resolved;
  assert(provider.kind === 'builtin_connector',
    `scenario provider is not a built-in connector: ${provider.id}`);
  assert(scenario.read_only, 'the built-in connector in this release requires a read-only scenario');
  const task = await registry.start({
    provider,
    scenario,
    prompt: compiledPrompt,
    workspace: args.workspace,
    scenarioId: scenario.id,
  });
  await appendAuditEvent(configPath, {
    event: 'connector-start', scenario_id: scenario.id, provider_id: provider.id,
    task_id: task.task_id, outcome: 'ok',
  }).catch(() => {});
  return task;
}

export async function getConnectorTask(args, {
  configPath,
  env = process.env,
  registry = connectorRegistryFor({ configPath, env }),
} = {}) {
  return registry.status(String(args?.task_id || ''), args?.wait_ms);
}

export async function controlConnectorTask(args, {
  configPath,
  env = process.env,
  registry = connectorRegistryFor({ configPath, env }),
} = {}) {
  const taskId = String(args?.task_id || '');
  const result = await registry.control(taskId, args || {});
  await appendAuditEvent(configPath, {
    event: 'connector-control', task_id: taskId,
    action: String(args?.action || ''), outcome: 'ok',
  }).catch(() => {});
  return result;
}
