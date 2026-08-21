import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  loadConfig,
  sanitizeConfig,
  saveConfig,
  validateConfig,
} from '../lib/config.mjs';
import { resolveSelection } from '../lib/control.mjs';
import { DEFAULT_CONFIG_PATH } from '../server.mjs';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'sol-control-config-'));
  const configPath = join(dir, 'control-plane.json');
  const config = await loadConfig({ configPath, defaultConfigPath: DEFAULT_CONFIG_PATH });
  return { dir, configPath, config };
}

test('bundled defaults are valid and external providers are off', async () => {
  const { config } = await fixture();
  assert.equal(config.version, 2);
  const external = config.providers.filter((provider) => provider.kind !== 'native_agent');
  assert.ok(external.length >= 4);
  assert.ok(external.every((provider) => provider.enabled === false));
  assert.equal(config.scenarios.find((scenario) => scenario.id === 'bounded-code-change').provider_id, 'native-luna');
  assert.equal(config.scenarios.find((scenario) => scenario.id === 'cross-review').provider_id, 'native-sol-reviewer');
});

test('sanitized status omits templates, endpoints, and credential names', async () => {
  const { config } = await fixture();
  const status = sanitizeConfig(config, { env: {} });
  const text = JSON.stringify(status);
  assert.doesNotMatch(text, /"template"\s*:/);
  assert.doesNotMatch(text, /example\.invalid/);
  assert.doesNotMatch(text, /SOL_CONTROL_CUSTOM_API_KEY/);
  assert.doesNotMatch(text, /CONSTRAINTS AND OWNERSHIP/);
  assert.match(text, /bounded-code-change/);
  assert.match(text, /template_revision/);
  assert.equal(status.scenarios.find((scenario) => scenario.id === 'bounded-code-change').requires_user_approval, true);
});

test('resolution returns only the selected compiled prompt and adapter', async () => {
  const { configPath } = await fixture();
  const { result } = await resolveSelection({
    scenario_id: 'bounded-code-change',
    task: 'Implement the parser guard.',
    context: { files: ['src/parser.ts'] },
    constraints: 'Own only src/parser.ts.',
    verification: 'Run npm test.',
    user_approved: true,
  }, { configPath, defaultConfigPath: DEFAULT_CONFIG_PATH, env: {} });
  assert.equal(result.adapter.execution, 'native_agent');
  assert.equal(result.adapter.agent_type, 'sol_advisor_luna_implementer');
  assert.match(result.compiled_prompt, /Implement the parser guard/);
  assert.match(result.compiled_prompt, /src\/parser\.ts/);
  assert.doesNotMatch(JSON.stringify(result), /Hard-path ChatGPT/);
  assert.doesNotMatch(result.compiled_prompt, /{{task}}/);
});

test('disabled and approval-gated routes fail closed', async () => {
  const { configPath, config } = await fixture();
  await assert.rejects(
    resolveSelection({ scenario_id: 'hard-path-web-advice', task: 'Review the blocker.' }, {
      configPath,
      defaultConfigPath: DEFAULT_CONFIG_PATH,
      env: {},
    }),
    /scenario is disabled/,
  );

  config.providers.find((provider) => provider.id === 'chatgpt-web-pro').enabled = true;
  config.scenarios.find((scenario) => scenario.id === 'hard-path-web-advice').enabled = true;
  await saveConfig(config, { configPath });
  await assert.rejects(
    resolveSelection({ scenario_id: 'hard-path-web-advice', task: 'Review the blocker.' }, {
      configPath,
      defaultConfigPath: DEFAULT_CONFIG_PATH,
      env: {},
    }),
    /requires explicit current-task user approval/,
  );
  const { result } = await resolveSelection({
    scenario_id: 'hard-path-web-advice',
    task: 'Review the blocker.',
    user_approved: true,
  }, { configPath, defaultConfigPath: DEFAULT_CONFIG_PATH, env: {} });
  assert.equal(result.adapter.execution, 'packet_review');
});

test('environment kill switch cannot be bypassed', async () => {
  const { configPath } = await fixture();
  await assert.rejects(
    resolveSelection({ scenario_id: 'bounded-code-change', task: 'Change one file.' }, {
      configPath,
      defaultConfigPath: DEFAULT_CONFIG_PATH,
      env: { SOL_CONTROL_DISABLED: '1' },
    }),
    /disabled by SOL_CONTROL_DISABLED/,
  );
});

test('configuration rejects stored MCP secrets and unknown placeholders', async () => {
  const { config } = await fixture();
  const secretConfig = structuredClone(config);
  secretConfig.providers.find((provider) => provider.id === 'cursor-local').config.api_token = 'bad';
  assert.throws(() => validateConfig(secretConfig), /looks like a stored secret/);

  const placeholderConfig = structuredClone(config);
  placeholderConfig.scenarios[0].template += '\n{{unknown_field}}';
  assert.throws(() => validateConfig(placeholderConfig), /unsupported placeholder/);
});


test('version-1 user config migrates built-in connectors without enabling or remapping user policy', async () => {
  const { configPath, config } = await fixture();
  const legacy = structuredClone(config);
  legacy.version = 1;
  legacy.providers = legacy.providers.filter((provider) => provider.id !== 'cursor-local');
  legacy.scenarios = legacy.scenarios.filter((scenario) => ![
    'grok-bounded-change', 'cursor-readonly-advice', 'cursor-bounded-change',
  ].includes(scenario.id));
  const grok = legacy.providers.find((provider) => provider.id === 'grok-local');
  grok.capabilities.write = false;
  grok.enabled = false;
  legacy.providers.push({
    id: 'cursor-bridge',
    name: 'User legacy Cursor bridge',
    kind: 'external_mcp',
    enabled: false,
    description: 'User-owned legacy descriptor that migration must preserve.',
    requires_user_approval: true,
    capabilities: { read: true, write: true, background: true },
    config: {
      protocol: 'user-cursor-v1',
      model_label: 'User Cursor',
      tools: { dispatch: 'cursor_do' },
      defaults: {},
      notes: 'custom',
    },
  });
  const brainstorm = legacy.scenarios.find((scenario) => scenario.id === 'brainstorm');
  brainstorm.description = 'USER CUSTOM DESCRIPTION';
  await writeFile(configPath, `${JSON.stringify(legacy, null, 2)}\n`);

  const migrated = await loadConfig({ configPath, defaultConfigPath: DEFAULT_CONFIG_PATH });
  assert.equal(migrated.version, 2);
  assert.equal(migrated.providers.find((provider) => provider.id === 'grok-local').capabilities.write, true);
  assert.equal(migrated.providers.find((provider) => provider.id === 'grok-local').enabled, false);
  assert.equal(migrated.providers.find((provider) => provider.id === 'cursor-local').enabled, false);
  assert.equal(migrated.providers.find((provider) => provider.id === 'cursor-bridge').config.protocol, 'user-cursor-v1');
  assert.equal(migrated.scenarios.find((scenario) => scenario.id === 'brainstorm').description,
    'USER CUSTOM DESCRIPTION');
  for (const scenarioId of ['grok-bounded-change', 'cursor-readonly-advice', 'cursor-bounded-change']) {
    const scenario = migrated.scenarios.find((item) => item.id === scenarioId);
    assert.ok(scenario);
    assert.equal(scenario.enabled, false);
    assert.equal(scenario.requires_user_approval, true);
  }
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).version, 2);
});


test('version-1 migration adds both built-in connectors disabled when legacy config has only external descriptors', async () => {
  const { configPath, config } = await fixture();
  const legacy = structuredClone(config);
  legacy.version = 1;
  legacy.providers = legacy.providers.filter((provider) => !['cursor-local', 'grok-local'].includes(provider.id));
  legacy.scenarios = legacy.scenarios.filter((scenario) => ![
    'grok-readonly-advice', 'grok-bounded-change', 'cursor-readonly-advice', 'cursor-bounded-change',
  ].includes(scenario.id));
  await writeFile(configPath, `${JSON.stringify(legacy, null, 2)}\n`);
  const migrated = await loadConfig({ configPath, defaultConfigPath: DEFAULT_CONFIG_PATH });
  for (const providerId of ['cursor-local', 'grok-local']) {
    const provider = migrated.providers.find((item) => item.id === providerId);
    assert.ok(provider);
    assert.equal(provider.enabled, false);
    assert.equal(provider.requires_user_approval, true);
    assert.equal(provider.capabilities.write, true);
  }
});
