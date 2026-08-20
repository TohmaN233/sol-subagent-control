import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
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
  assert.equal(config.version, 1);
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
});

test('resolution returns only the selected compiled prompt and adapter', async () => {
  const { configPath } = await fixture();
  const { result } = await resolveSelection({
    scenario_id: 'bounded-code-change',
    task: 'Implement the parser guard.',
    context: { files: ['src/parser.ts'] },
    constraints: 'Own only src/parser.ts.',
    verification: 'Run npm test.',
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
  secretConfig.providers.find((provider) => provider.id === 'cursor-bridge').config.api_token = 'bad';
  assert.throws(() => validateConfig(secretConfig), /looks like a stored secret/);

  const placeholderConfig = structuredClone(config);
  placeholderConfig.scenarios[0].template += '\n{{unknown_field}}';
  assert.throws(() => validateConfig(placeholderConfig), /unsupported placeholder/);
});
