import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inventory as assertInventorySchema } from './assertions.mjs';
import { createTurnProbeClient } from './turn-probe-client.mjs';
import { skillPathKey } from './assertions.mjs';
import {
  FIXTURE_CONFIG, FIXTURE_INSTRUCTIONS, fixtureCatalog,
  createFixturePolicy, assertFixtureThread,
} from './fixture-policy.mjs';

export const PROBE_MODEL = 'gpt-5.6-sol';
export const PROBE_PROMPT = 'Handle the Sol workflow isolation probe. Output only the marker specified by the matching available Skill, or WORKFLOW_ONLY if none matches.';

export async function startSyntheticSession(binary, workspace, profile, { endpoint, live = false } = {}) {
  assert.equal(Boolean(endpoint), !live, 'Choose exactly one of local mock provider or managed live auth');
  if (endpoint) {
    const url = new URL(endpoint);
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(url.protocol, 'http:');
  }
  const catalog = join(profile.home, 'fixture-model-catalog.json');
  await writeFile(catalog, JSON.stringify(fixtureCatalog(PROBE_MODEL)), { flag: 'wx' });
  await writeFile(join(profile.home, 'config.toml'),
    `model = "${PROBE_MODEL}"\nmodel_catalog_json = ${JSON.stringify(catalog)}\n` +
    (endpoint ? 'model_provider = "probe"\n' : '') + FIXTURE_CONFIG +
    (endpoint ? `\n[model_providers.probe]\nname = "Loopback synthetic probe"\nbase_url = ${JSON.stringify(endpoint)}\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n` : ''));
  const policy = await createFixturePolicy(workspace, profile);
  let activeThread;
  let activeLabel;
  let reads = [];
  const client = createTurnProbeClient(binary, {
    home: profile.home, cwd: workspace.cwd, live,
    onToolCall(params) {
      assert.equal(params.threadId, activeThread, 'Tool call outside active probe thread');
      assert.equal(params.tool, 'read_probe_skill', 'Unknown dynamic tool');
      assert(!params.namespace, 'Unknown dynamic namespace');
      let result;
      try { result = policy.read(params.arguments); }
      catch (error) { throw new Error(`Dynamic fixture read rejected in ${activeLabel}: ${error.message}`); }
      reads.push({ path: params.arguments.path, callId: params.callId });
      return result;
    },
  });
  try {
    await client.call('initialize', { clientInfo: { name: 'sol_synthetic_turn_probe', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    client.initialized();
  } catch (error) {
    try { await client.close(); } catch (closeError) { throw new AggregateError([error, closeError], 'Initialization and close failed'); }
    throw error;
  }
  async function inventory() {
    const result = await client.call('skills/list', { cwds: [workspace.cwd], forceReload: true });
    try { return assertInventorySchema(result, workspace.cwd); }
    catch (error) { throw new Error(`Skill inventory validation failed: ${error.message}`); }
  }
  return {
    client,
    async setAllowed(paths) {
      policy.setAllowed(paths);
      const allowed = new Set(paths.map(skillPathKey));
      for (const skill of await inventory()) {
        await client.call('skills/config/write', { path: skill.path, enabled: allowed.has(skillPathKey(skill.path)) });
      }
      policy.assertInventory(await inventory());
    },
    async turn(label, { explicit = false, repositoryEnvironment = false } = {}) {
      assert(!live || !repositoryEnvironment, 'Live probe must have no execution environment');
      policy.assertInventory(await inventory());
      const input = [{ type: 'text', text: explicit ? '$sol-isolation-allowed ' + PROBE_PROMPT : PROBE_PROMPT }];
      if (explicit) {
        // Enforce explicit injection independently from host discovery settings.
        policy.read({ path: profile.allowedSkill });
        input.push({ type: 'skill', name: 'sol-isolation-allowed', path: profile.allowedSkill });
      }
      const start = await client.call('thread/start', {
        cwd: workspace.cwd, model: PROBE_MODEL, ...(endpoint ? { modelProvider: 'probe' } : {}),
        approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true,
        ...(repositoryEnvironment ? {} : { environments: [] }),
        baseInstructions: FIXTURE_INSTRUCTIONS, dynamicTools: policy.tools(),
      });
      assertFixtureThread(start);
      assert.equal(start.model, PROBE_MODEL, 'Silent model substitution');
      activeThread = start.thread.id;
      activeLabel = label;
      reads = [];
      const after = client.events.length;
      const begun = await client.call('turn/start', { threadId: activeThread, effort: 'low', input });
      const completed = await client.waitFor(event => event.method === 'turn/completed' && event.params.threadId === activeThread && event.params.turn.id === begun.turn.id, { after });
      assert.equal(completed.params.turn.status, 'completed', `Turn ${label} failed`);
      const items = client.events.slice(after).filter(event => event.method === 'item/completed' && event.params.threadId === activeThread).map(event => event.params.item);
      const output = items.filter(item => item.type === 'agentMessage').map(item => item.text).join('\n').trim();
      const result = { label, status: completed.params.turn.status, output, reads: [...reads], item_types: items.map(item => item.type) };
      activeThread = undefined;
      return result;
    },
  };
}
