import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCodexClient } from './codex-app-server-client.mjs';
import { buildCodexProfile, cleanupCodexProfile, recordProfileChild, isolatedEnvironment, pinObservedModel, profileOverrides, STRICT_INSTRUCTIONS } from './codex-profile-builder.mjs';
import { createSkillPolicy } from './codex-skill-policy.mjs';
import { canonicalJSON, digest } from '../workflow-revisions.mjs';
import { requireValue, noSymlinks } from '../workflow-paths.mjs';

export function codexEventMetadata(event) {
  const p = event.params ?? {};
  return { method: event.method, thread_id: typeof p.threadId === 'string' ? p.threadId : null,
    turn_id: typeof p.turn?.id === 'string' ? p.turn.id : typeof p.turnId === 'string' ? p.turnId : null,
    item_type: typeof p.item?.type === 'string' ? p.item.type : null,
    status: typeof p.turn?.status === 'string' ? p.turn.status : null,
  };
}

// Candidate session engine, not a qualification grant. The host must require an
// executor certificate before allowing production Strict dispatch through it.
export async function createStrictSession(options) {
  const { cwd, model, effort, allowedSkills = [], skillPolicy, env = process.env, onEvent = () => {}, onToolRead = () => {} } = options;
  const profile = await buildCodexProfile(options); let client; let policy; let activeThread = null; let activeTurn = null; let closed = false; let used = false; let closing;
  try {
    policy = await createSkillPolicy({ home: profile.home, cwd, skillPolicy, allowed: allowedSkills });
    // Trusted in-process lifecycle hook for the host ownership journal. This is
    // never a Workflow/MCP argument and is not serialized to an executor.
    if (options.onProfilePrepared) await options.onProfilePrepared(structuredClone(profile));
    async function launch() {
    await noSymlinks(options.binary);
    requireValue(digest(await readFile(options.binary)) === profile.binary_sha256, 'CODEX_BINARY_CHANGED', 'Codex executable changed before process launch');
    client = createCodexClient(options.binary, { home: profile.home, cwd: profile.model_catalog_sha256 ? cwd : profile.home,
      overrides: profileOverrides(profile), env: isolatedEnvironment(env, profile.home),
      onEvent: event => onEvent(codexEventMetadata(event)),
      async onToolCall(params) {
        requireValue(!closed && params.threadId === activeThread && !params.namespace, 'CODEX_TOOL_DENIED', 'Tool call is outside this node execution envelope');
        if (params.tool === 'read_allowed_skill') {
          if (options.authorize) await options.authorize();
          const result = policy.read(params.arguments); await onToolRead({ call_id: params.callId, path: params.arguments.path }); return result;
        }
        requireValue(options.toolBroker, 'CODEX_TOOL_DENIED', 'No workspace/resource broker was authorized');
        return options.toolBroker.call(params.tool, params.arguments, params.callId);
      },
    });
    await recordProfileChild(profile, client.pid);
    await client.call('initialize', { clientInfo: { name: 'sol_strict_workflow', version: '0.1.0' }, capabilities: { experimentalApi: true } }); client.initialized();
    }
    await launch();
    if (!options.modelMetadata) {
      const models = []; const cursors = new Set(); let cursor;
      do {
        requireValue(cursors.size < 20, 'CODEX_MODEL_SCHEMA', 'Model pagination exceeded its bounded page count');
        const page = await client.call('model/list', { includeHidden: true, limit: 100, ...(cursor ? { cursor } : {}) });
        requireValue(Array.isArray(page.data) && models.length + page.data.length <= 1000, 'CODEX_MODEL_SCHEMA', 'Invalid or excessive public model inventory'); models.push(...page.data);
        cursor = page.nextCursor;
        requireValue(!cursor || typeof cursor === 'string' && !cursors.has(cursor), 'CODEX_MODEL_SCHEMA', 'Repeated/invalid model pagination cursor'); if (cursor) cursors.add(cursor);
      } while (cursor);
      const matches = models.filter(item => item.model === model);
      requireValue(matches.length === 1, 'CODEX_MODEL_UNAVAILABLE', 'Pinned model was not uniquely returned by App Server model/list');
      await client.close(); await pinObservedModel(profile, matches[0]); await launch();
    }
    await policy.apply(client);
  } catch (error) {
    const errors = [error]; if (client) try { await client.close(); } catch (e) { errors.push(e); }
    try { await cleanupCodexProfile(profile); } catch (e) { errors.push(e); }
    if (errors.length > 1) throw Object.assign(new AggregateError(errors, 'Strict session setup/cleanup failed'), { retained_at: profile.home });
    throw error;
  }
  const session = {
    profile, client,
    async authentication() {
      const result = await client.call('account/read', { refreshToken: false });
      requireValue(result && typeof result.requiresOpenaiAuth === 'boolean', 'CODEX_AUTH_SCHEMA', 'Unsupported account metadata response');
      return { authenticated: Boolean(result.account) || result.requiresOpenaiAuth === false, type: result.account?.type ?? null };
    },
    async login({ apiKeyEnv } = {}) {
      requireValue(!options.endpoint, 'CODEX_AUTH_FLOW', 'Local qualification never requests credentials');
      if (apiKeyEnv !== undefined) {
        requireValue(/^[A-Z_][A-Z0-9_]{0,127}$/.test(apiKeyEnv) && env[apiKeyEnv], 'CODEX_CREDENTIAL_MISSING', 'Configured authentication environment variable is unavailable');
        await client.call('account/login/start', { type: 'apiKey', apiKey: env[apiKeyEnv] });
        return session.authentication();
      }
      const result = await client.call('account/login/start', { type: 'chatgpt' });
      requireValue(typeof result.authUrl === 'string' && typeof result.loginId === 'string', 'CODEX_AUTH_SCHEMA', 'Managed login returned no supported browser flow');
      const url = new URL(result.authUrl);
      requireValue(url.protocol === 'https:' && url.hostname === 'auth.openai.com', 'CODEX_AUTH_ORIGIN', 'Managed login returned an unexpected authentication origin');
      // The authenticated human console may display this transient URL; never
      // append it to the Run journal, diagnostics or worker tool results.
      return { authenticated: false, login_id: result.loginId, auth_url: result.authUrl };
    },
    async cancelLogin(loginId) { await client.call('account/login/cancel', { loginId }); },
    async turn(text, { explicit_sources = [], timeout_ms = 60000 } = {}) {
      requireValue(!activeThread && !closed && !used, 'CODEX_SESSION_BUSY', 'Each strict profile may execute exactly one fresh node');
      requireValue(typeof text === 'string' && text.length > 0 && text.length <= 200000, 'CODEX_PROMPT_LIMIT', 'Node prompt must be bounded text');
      requireValue((await session.authentication()).authenticated, 'CODEX_AUTH_REQUIRED', 'Strict node is waiting for supported authentication');
      await policy.verify(client);
      const skillInputs = policy.explicitInputs(explicit_sources);
      used = true;
      const started = await client.call('thread/start', { cwd, model, ...(options.endpoint ? { modelProvider: 'qualification' } : {}), approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true,
        environments: [], baseInstructions: STRICT_INSTRUCTIONS, dynamicTools: [...policy.tools(), ...(options.toolBroker?.tools() ?? [])],
      });
      requireValue(Array.isArray(started.instructionSources) && !started.instructionSources.length && started.model === model && typeof started.thread?.id === 'string', 'CODEX_THREAD_UNCONTROLLED', 'Fresh thread has unexpected instruction sources, model substitution or schema');
      activeThread = started.thread.id;
      try {
        await policy.verify(client);
        const input = [{ type: 'text', text }, ...skillInputs];
        const profileHash = digest(await readFile(join(profile.home, 'config.toml')));
        const after = client.events.length;
        const begun = await client.call('turn/start', { threadId: activeThread, effort, input }); activeTurn = begun.turn.id;
        const completed = await client.waitFor(event => event.method === 'turn/completed' && event.params.threadId === activeThread && event.params.turn.id === activeTurn, { after, timeout: timeout_ms });
        requireValue(completed.params.turn.status === 'completed', 'CODEX_TURN_FAILED', `Strict turn ended with status ${completed.params.turn.status}`);
        await policy.verify(client);
        requireValue(digest(await readFile(join(profile.home, 'config.toml'))) === profileHash && digest(await readFile(join(profile.home, 'models.json'))) === profile.model_catalog_sha256, 'CODEX_PROFILE_CHANGED', 'Strict profile policy/model metadata changed during execution');
        const items = client.events.slice(after).filter(event => event.method === 'item/completed' && event.params.threadId === activeThread).map(event => event.params.item);
        requireValue(items.every(item => ['userMessage', 'agentMessage', 'reasoning', 'dynamicToolCall', 'plan', 'contextCompaction'].includes(item.type)), 'CODEX_ITEM_UNCONTROLLED', `Strict turn used unqualified execution items: ${items.map(item => item.type).join(', ')}`);
        const output = items.filter(item => item.type === 'agentMessage').map(item => item.text).join('\n').trim();
        requireValue(output.length > 0, 'CODEX_OUTPUT_EMPTY', 'Strict node returned no result');
        return { output, thread_id: activeThread, turn_id: activeTurn, item_types: items.map(item => item.type), audit: { ...policy.audit(), profile_hash: profileHash,
          executable_sha256: profile.binary_sha256, schema: 'codex-0.145.0-stdio-v2-experimental', skill_input_items: skillInputs.map(item => ({ name: item.name, path: item.path })), input_sha256: digest(canonicalJSON(input)) } };
      } catch (error) {
        // A failed/deadline turn must not keep executing after its lease fails.
        // Closing the owned subprocess is the definitive local stop boundary.
        try { await session.close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Strict turn and shutdown failed; profile retained'); }
        throw error;
      } finally { activeThread = null; activeTurn = null; }
    },
    async interrupt() { if (activeThread && activeTurn) await client.call('turn/interrupt', { threadId: activeThread, turnId: activeTurn }); },
    async close() {
      if (closing) return closing;
      closed = true; options.toolBroker?.revoke();
      closing = (async () => {
        await client.close();
        let timer; let outcome;
        try {
          outcome = options.toolBroker ? await Promise.race([options.toolBroker.quiesce(), new Promise((_, reject) => {
            timer = setTimeout(() => reject(Object.assign(new Error('Workspace tool did not quiesce; retain profile'), { code: 'CODEX_BROKER_SHUTDOWN_TIMEOUT' })), 5000);
          })]) : null;
        } finally { clearTimeout(timer); }
        await cleanupCodexProfile(profile);
        if (outcome?.error) throw Object.assign(new Error('Workspace tool failed during shutdown'), { code: 'CODEX_BROKER_SHUTDOWN_FAILURE', cause: outcome.error, profile_cleaned: true });
      })();
      return closing;
    },
  };
  return session;
}
