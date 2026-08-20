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
    compiled_prompt: compiledPrompt,
  };

  if (audit) {
    await appendAuditEvent(configPath, {
      event: 'resolve',
      scenario_id: scenario.id,
      provider_id: provider.id,
      outcome: 'ok',
    }).catch(() => {});
  }
  return { result, config, scenario, provider };
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
