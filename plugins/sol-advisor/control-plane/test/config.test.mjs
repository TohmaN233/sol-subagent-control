import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from './physical-tempdir.mjs';
import { join } from 'node:path';
import test from 'node:test';

import {
  loadConfig,
  resolveConfigPath,
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

test('default config path is user-global and independent of the project directory', () => {
  const userHome = join(tmpdir(), 'sol-control-user');
  assert.equal(
    resolveConfigPath({}, userHome),
    join(userHome, '.codex', 'sol-advisor', 'control-plane.json'),
  );
  assert.equal(
    resolveConfigPath({ CODEX_HOME: join(userHome, 'custom-codex-home') }, userHome),
    join(userHome, 'custom-codex-home', 'sol-advisor', 'control-plane.json'),
  );
});

test('bundled defaults use delegate for light work and full for difficult work', async () => {
  const { config } = await fixture();
  assert.equal(config.version, 6);
  assert.equal('scenarios' in config, false);
  const external = config.providers.filter((provider) => provider.kind !== 'native_agent');
  assert.ok(external.length >= 4);
  assert.ok(external.every((provider) => provider.enabled === false));
  const webReview = config.providers.find((provider) => provider.id === 'chatgpt-web-pro');
  assert.equal(webReview.config.model_label, '');
  assert.equal('reasoning_effort' in webReview.config, false);
  assert.equal(sanitizeConfig(config, { env: {} }).providers
    .find((provider) => provider.id === 'chatgpt-web-pro').model_label, null);
  const bounded = config.task_types.find((taskType) => taskType.id === 'bounded-code-change');
  assert.equal(bounded.route, 'delegate');
  assert.deepEqual(bounded.stages.map((stage) => [stage.id, stage.role, stage.provider_id]), [
    ['implementation', 'implementer', 'native-luna'],
  ]);
  const review = config.task_types.find((taskType) => taskType.id === 'cross-review');
  assert.deepEqual(review.stages.map((stage) => [stage.id, stage.role, stage.provider_id]), [
    ['review', 'reviewer', 'native-sol-reviewer'],
  ]);
  const analysis = config.task_types.find((taskType) => taskType.id === 'repository-analysis');
  assert.deepEqual(analysis.stages.map((stage) => [stage.role, stage.access]), [
    ['implementer', 'read_only'],
  ]);
  const full = config.task_types.find((taskType) => taskType.id === 'implementation-with-review');
  assert.deepEqual(full.stages.map((stage) => [stage.id, stage.role]), [
    ['implementation', 'implementer'], ['review', 'reviewer'],
  ]);
  const difficult = config.task_types.find((taskType) => taskType.id === 'judgment-heavy-change');
  assert.equal(difficult.route, 'full');
  assert.deepEqual(difficult.stages.map((stage) => stage.id), ['implementation', 'review']);
  for (const taskType of config.task_types) {
    const providerSpecificText = `${taskType.id} ${taskType.name} ${taskType.description} ${taskType.tags.join(' ')}`;
    assert.doesNotMatch(providerSpecificText, /cursor|grok|chatgpt|luna|terra|openai/i);
  }
});

test('task type route is derived from stages and cannot conflict with them', async () => {
  const { config } = await fixture();
  const bounded = config.task_types.find((taskType) => taskType.id === 'bounded-code-change');
  bounded.route = 'solo';
  assert.equal(validateConfig(config).task_types
    .find((taskType) => taskType.id === 'bounded-code-change').route, 'delegate');
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
  const bounded = status.task_types.find((taskType) => taskType.id === 'bounded-code-change');
  assert.equal(bounded.stages[0].requires_user_approval, false);
});

test('bundled approval gates default off and only explicit provider or stage opt-in requires approval', async () => {
  const { configPath, config } = await fixture();
  assert.equal(config.providers.some((provider) => provider.requires_user_approval), false);
  assert.equal(config.task_types.some((taskType) =>
    taskType.stages.some((stage) => stage.requires_user_approval)), false);

  const unguarded = await resolveSelection({
    task_type_id: 'bounded-code-change',
    task: 'Implement the parser guard.',
  }, { configPath, defaultConfigPath: DEFAULT_CONFIG_PATH, env: {} });
  assert.equal(unguarded.result.stages[0].approval_required, false);

  const bounded = config.task_types.find((taskType) => taskType.id === 'bounded-code-change');
  bounded.stages[0].requires_user_approval = true;
  await saveConfig(config, { configPath });
  await assert.rejects(
    resolveSelection({ task_type_id: 'bounded-code-change', task: 'Implement it.' }, {
      configPath, defaultConfigPath: DEFAULT_CONFIG_PATH, env: {},
    }),
    /requires explicit current-task user approval/,
  );

  bounded.stages[0].requires_user_approval = false;
  config.providers.find((provider) => provider.id === 'native-luna').requires_user_approval = true;
  await saveConfig(config, { configPath });
  await assert.rejects(
    resolveSelection({ task_type_id: 'bounded-code-change', task: 'Implement it.' }, {
      configPath, defaultConfigPath: DEFAULT_CONFIG_PATH, env: {},
    }),
    /requires explicit current-task user approval/,
  );
});

test('resolution returns only the selected compiled prompt and adapter', async () => {
  const { configPath } = await fixture();
  const { result } = await resolveSelection({
    task_type_id: 'bounded-code-change',
    task: 'Implement the parser guard.',
    context: { files: ['src/parser.ts'] },
    constraints: 'Own only src/parser.ts.',
    verification: 'Run npm test.',
    user_approved: true,
  }, { configPath, defaultConfigPath: DEFAULT_CONFIG_PATH, env: {} });
  assert.equal(result.stages[0].adapter.execution, 'native_agent');
  assert.equal(result.stages[0].adapter.agent_type, 'sol_advisor_luna_implementer');
  assert.match(result.stages[0].compiled_prompt, /Implement the parser guard/);
  assert.match(result.stages[0].compiled_prompt, /src\/parser\.ts/);
  assert.doesNotMatch(JSON.stringify(result), /Hard-path ChatGPT/);
  assert.doesNotMatch(result.stages[0].compiled_prompt, /{{task}}/);
});

test('disabled and approval-gated routes fail closed', async () => {
  const { configPath, config } = await fixture();
  await assert.rejects(
    resolveSelection({ task_type_id: 'hard-path-web-advice', task: 'Review the blocker.' }, {
      configPath,
      defaultConfigPath: DEFAULT_CONFIG_PATH,
      env: {},
    }),
    /task type is disabled/,
  );

  config.providers.find((provider) => provider.id === 'chatgpt-web-pro').enabled = true;
  const hardPath = config.task_types.find((taskType) => taskType.id === 'hard-path-web-advice');
  hardPath.enabled = true;
  hardPath.stages[0].requires_user_approval = true;
  await saveConfig(config, { configPath });
  await assert.rejects(
    resolveSelection({ task_type_id: 'hard-path-web-advice', task: 'Review the blocker.' }, {
      configPath,
      defaultConfigPath: DEFAULT_CONFIG_PATH,
      env: {},
    }),
    /requires explicit current-task user approval/,
  );
  const { result } = await resolveSelection({
    task_type_id: 'hard-path-web-advice',
    task: 'Review the blocker.',
    user_approved: true,
  }, { configPath, defaultConfigPath: DEFAULT_CONFIG_PATH, env: {} });
  assert.equal(result.stages[0].adapter.execution, 'packet_review');
  assert.equal(result.stages[0].adapter.model_label, null);
});

test('environment kill switch cannot be bypassed', async () => {
  const { configPath } = await fixture();
  await assert.rejects(
    resolveSelection({ task_type_id: 'bounded-code-change', task: 'Change one file.' }, {
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
  placeholderConfig.task_types[0].stages[0].template += '\n{{unknown_field}}';
  assert.throws(() => validateConfig(placeholderConfig), /unsupported placeholder/);

});


function asVersion2(config) {
  return {
    version: 2,
    global: structuredClone(config.global),
    providers: structuredClone(config.providers),
    scenarios: config.task_types.map((taskType) => {
      const stage = taskType.stages[0];
      return {
        id: taskType.id,
        name: taskType.name,
        enabled: taskType.enabled,
        description: taskType.description,
        route: taskType.route,
        provider_id: stage?.provider_id || 'native-luna',
        read_only: stage ? stage.access === 'read_only' : true,
        requires_user_approval: stage?.requires_user_approval || false,
        tags: taskType.tags,
        template: stage?.template || 'Handle {{task}}.',
      };
    }),
  };
}

test('version-2 config migrates task types and removes untouched disabled provider-specific defaults', async () => {
  const { configPath, config } = await fixture();
  const legacy = asVersion2(config);
  const brainstorm = legacy.scenarios.find((scenario) => scenario.id === 'brainstorm');
  brainstorm.description = 'USER CUSTOM DESCRIPTION';
  legacy.scenarios.push({
    id: 'cursor-bounded-change', name: 'Cursor bounded repository change', enabled: false,
    description: 'old bundled task', route: 'delegate', provider_id: 'cursor-local',
    read_only: false, requires_user_approval: true, tags: ['cursor'], template: 'Do {{task}}.',
  });
  await writeFile(configPath, `${JSON.stringify(legacy, null, 2)}\n`);

  const migrated = await loadConfig({ configPath, defaultConfigPath: DEFAULT_CONFIG_PATH });
  assert.equal(migrated.version, 6);
  assert.equal(migrated.task_types.find((taskType) => taskType.id === 'brainstorm').description,
    'USER CUSTOM DESCRIPTION');
  assert.equal(migrated.task_types.some((taskType) => taskType.id === 'cursor-bounded-change'), false);
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).version, 6);
});

test('version-2 full route migrates disabled with a separate read-only reviewer', async () => {
  const { configPath, config } = await fixture();
  const legacy = asVersion2(config);
  legacy.scenarios.push({
    id: 'legacy-full', name: 'Legacy full', enabled: true, description: 'Needs review.',
    route: 'full', provider_id: 'native-luna', read_only: false,
    requires_user_approval: true, tags: ['legacy'], template: 'Implement {{task}}.',
  });
  await writeFile(configPath, `${JSON.stringify(legacy, null, 2)}\n`);
  const migrated = await loadConfig({ configPath, defaultConfigPath: DEFAULT_CONFIG_PATH });
  const taskType = migrated.task_types.find((item) => item.id === 'legacy-full');
  assert.equal(taskType.enabled, false);
  assert.deepEqual(taskType.stages.map((stage) => [stage.id, stage.provider_id, stage.access]), [
    ['implementation', 'native-luna', 'bounded_write'],
    ['review', 'native-sol-reviewer', 'read_only'],
  ]);
});

test('version-3 difficult default preserves a customized implementation while adding review', async () => {
  const { configPath, config } = await fixture();
  config.version = 3;
  const difficult = config.task_types.find((taskType) => taskType.id === 'judgment-heavy-change');
  difficult.route = 'delegate';
  difficult.stages = difficult.stages.slice(0, 1);
  difficult.stages[0].template = 'CUSTOM IMPLEMENTATION {{task}} {{context}} {{constraints}} {{verification}}';
  const crossReview = config.task_types.find((taskType) => taskType.id === 'cross-review');
  crossReview.stages[0].provider_id = 'grok-local';
  config.providers.find((provider) => provider.id === 'grok-local').enabled = true;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const migrated = await loadConfig({ configPath, defaultConfigPath: DEFAULT_CONFIG_PATH });
  assert.equal(migrated.version, 6);
  assert.deepEqual(migrated.task_types.find((taskType) => taskType.id === 'judgment-heavy-change')
    .stages.map((stage) => [stage.id, stage.provider_id]), [
    ['implementation', 'native-terra'], ['review', 'native-sol-reviewer'],
  ]);
  assert.match(migrated.task_types.find((taskType) => taskType.id === 'judgment-heavy-change')
    .stages[0].template, /CUSTOM IMPLEMENTATION/);
  assert.equal(migrated.task_types.find((taskType) => taskType.id === 'cross-review')
    .stages[0].provider_id, 'grok-local');
  assert.equal(migrated.providers.find((provider) => provider.id === 'grok-local').enabled, true);
});

test('version-3 customized difficult Task Type keeps its user-owned workflow', async () => {
  const { configPath, config } = await fixture();
  config.version = 3;
  const difficult = config.task_types.find((taskType) => taskType.id === 'judgment-heavy-change');
  difficult.route = 'delegate';
  difficult.stages = difficult.stages.slice(0, 1);
  difficult.description = 'User intentionally keeps this as one implementation Stage.';
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const migrated = await loadConfig({ configPath, defaultConfigPath: DEFAULT_CONFIG_PATH });
  assert.equal(migrated.version, 6);
  assert.equal(migrated.task_types.find((taskType) => taskType.id === 'judgment-heavy-change').route,
    'delegate');
});

test('version-4 difficult workflow retries migration after the strict v3 migration skipped it', async () => {
  const { configPath, config } = await fixture();
  config.version = 4;
  const difficult = config.task_types.find((taskType) => taskType.id === 'judgment-heavy-change');
  difficult.route = 'delegate';
  difficult.stages = difficult.stages.slice(0, 1);
  difficult.stages[0].template = 'PREVIOUSLY CUSTOMIZED {{task}} {{context}} {{constraints}} {{verification}}';
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const migrated = await loadConfig({ configPath, defaultConfigPath: DEFAULT_CONFIG_PATH });
  const migratedDifficult = migrated.task_types.find(
    (taskType) => taskType.id === 'judgment-heavy-change');
  assert.equal(migrated.version, 6);
  assert.equal(migratedDifficult.route, 'full');
  assert.deepEqual(migratedDifficult.stages.map((stage) => stage.id), ['implementation', 'review']);
  assert.match(migratedDifficult.stages[0].template, /PREVIOUSLY CUSTOMIZED/);
});

test('version-5 migration clears inherited bundled approval gates and preserves custom opt-ins', async () => {
  const { configPath, config } = await fixture();
  config.version = 5;
  config.providers.find((provider) => provider.id === 'cursor-local').requires_user_approval = true;
  config.providers.find((provider) => provider.id === 'native-luna').requires_user_approval = true;
  config.task_types.find((taskType) => taskType.id === 'hard-path-web-advice')
    .stages[0].requires_user_approval = true;
  config.task_types.push({
    id: 'custom-approval', name: 'Custom approval', enabled: false,
    description: 'User-owned opt-in approval fixture.', route: 'delegate', tags: ['custom'],
    stages: [{
      id: 'implementation', role: 'implementer', provider_id: 'native-luna',
      access: 'read_only', requires_user_approval: true,
      template: 'Inspect {{task}} with {{context}} under {{constraints}} and verify {{verification}}.',
    }],
  });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const migrated = await loadConfig({ configPath, defaultConfigPath: DEFAULT_CONFIG_PATH });
  assert.equal(migrated.version, 6);
  assert.equal(migrated.providers.find((provider) => provider.id === 'cursor-local')
    .requires_user_approval, false);
  assert.equal(migrated.task_types.find((taskType) => taskType.id === 'hard-path-web-advice')
    .stages[0].requires_user_approval, false);
  assert.equal(migrated.providers.find((provider) => provider.id === 'native-luna')
    .requires_user_approval, true);
  assert.equal(migrated.task_types.find((taskType) => taskType.id === 'custom-approval')
    .stages[0].requires_user_approval, true);
});

test('full resolves implementation then review with pinned providers and no fallback', async () => {
  const { configPath, config } = await fixture();
  config.task_types.push({
    id: 'full-fixture', name: 'Full fixture', enabled: true,
    description: 'Two-stage test workflow.', route: 'full', tags: ['fixture'],
    stages: [
      {
        id: 'implementation', role: 'implementer', provider_id: 'native-luna',
        access: 'bounded_write', requires_user_approval: true,
        template: 'Implement {{task}} with {{context}} and {{constraints}}; verify {{verification}}.',
      },
      {
        id: 'review', role: 'reviewer', provider_id: 'native-sol-reviewer',
        access: 'read_only', requires_user_approval: false,
        template: 'Review {{task}} with {{context}} and {{constraints}}; verify {{verification}}.',
      },
    ],
  });
  await saveConfig(config, { configPath });
  const { result } = await resolveSelection({
    task_type_id: 'full-fixture', task: 'Change and review.', user_approved: true,
  }, { configPath, defaultConfigPath: DEFAULT_CONFIG_PATH, env: {} });
  assert.deepEqual(result.stages.map((stage) => [stage.stage.id, stage.provider.id]), [
    ['implementation', 'native-luna'], ['review', 'native-sol-reviewer'],
  ]);

  config.providers.find((provider) => provider.id === 'native-sol-reviewer').enabled = false;
  await saveConfig(config, { configPath });
  await assert.rejects(
    resolveSelection({ task_type_id: 'full-fixture', task: 'Change and review.', user_approved: true }, {
      configPath, defaultConfigPath: DEFAULT_CONFIG_PATH, env: {},
    }),
    /provider is disabled: native-sol-reviewer/,
  );
});


test('version-1 migration adds both built-in connectors disabled when legacy config has only external descriptors', async () => {
  const { configPath, config } = await fixture();
  const legacy = asVersion2(config);
  legacy.version = 1;
  legacy.providers = legacy.providers.filter((provider) => !['cursor-local', 'grok-local'].includes(provider.id));
  await writeFile(configPath, `${JSON.stringify(legacy, null, 2)}\n`);
  const migrated = await loadConfig({ configPath, defaultConfigPath: DEFAULT_CONFIG_PATH });
  for (const providerId of ['cursor-local', 'grok-local']) {
    const provider = migrated.providers.find((item) => item.id === providerId);
    assert.ok(provider);
    assert.equal(provider.enabled, false);
    assert.equal(provider.requires_user_approval, false);
    assert.equal(provider.capabilities.write, true);
  }
  assert.equal(migrated.version, 6);
});
