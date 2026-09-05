import { dirname, join, resolve } from 'node:path';
import { loadConfig, isEnvironmentDisabled } from './config.mjs';
import { WorkflowStore } from './workflow-store.mjs';
import { WorkflowRuntime } from './workflow-runtime.mjs';
import { WorkflowExecutor } from './workflow-executor.mjs';
import { validateWorkflowGraph } from './workflow-validator.mjs';
import { migrateV6OnDisk, restoreV6Backup } from './workflow-migration-v6.mjs';
import { resolveLegacyWorkflowRequest } from './legacy-control-adapter.mjs';
import { connectorRegistryFor } from '../connectors/registry.mjs';
import { requireValue, insideRoot, noSymlinks } from './workflow-paths.mjs';
import { importCoarseSkill, verifyCoarseRelocation } from './skill-import/coarse-compiler.mjs';
import { expansionPacket, applyExpansion } from './skill-import/semantic-expander.mjs';
import { buildProviderAdapter } from './providers.mjs';
import { strictManagerFor } from './execution/strict-session-manager.mjs';
import { importReviewPacket, reviewImportedDraft } from './skill-import/review-import.mjs';
import { expansionRunPack } from './skill-import/expansion-run.mjs';
import { SkillInventory } from './skill-import/inventory.mjs';
import { discoverCodexSkills } from './skill-import/codex-inventory.mjs';
import { resolveWorkflowPins } from './workflow-pins.mjs';
import { canonicalJSON, digest } from './workflow-revisions.mjs';
import { inlineSkillReference } from './skill-import/inline-skill.mjs';
import { parallelManagerFor } from './parallel/worktree-manager.mjs';

export class WorkflowService {
  constructor({ configPath, defaultConfigPath, env = process.env, fetchImpl = globalThis.fetch, registry, capabilities = {} }) {
    this.configPath = resolve(configPath); this.defaultConfigPath = defaultConfigPath; this.env = env; this.fetchImpl = fetchImpl;
    this.registry = registry ?? connectorRegistryFor({ configPath: this.configPath, env }); this.capabilities = capabilities;
    this.strictManager = capabilities.strictManager ?? strictManagerFor({ configPath: this.configPath, getConfig: () => this.config(), env });
    this.parallelManager = capabilities.parallelManager ?? parallelManagerFor({ configPath: this.configPath, env });
    this.skillInventory = capabilities.skillInventory ?? new SkillInventory(async workspace => discoverCodexSkills(workspace, { config: await this.config(), env }));
  }
  async config() { return loadConfig({ configPath: this.configPath, defaultConfigPath: this.defaultConfigPath }); }
  async validationContext(store, workflow, context) {
    const initial = validateWorkflowGraph(workflow, context);
    const deferred = new Set(['SKILL_MISSING', 'SKILL_STALE', 'SUBWORKFLOW_MISSING', 'SUBWORKFLOW_INVALID']);
    if (initial.errors.some(error => !deferred.has(error.code))) return { context, validation: initial };
    try {
      const root = { workflow, resources: [], revision_hash: digest(canonicalJSON(workflow)) };
      const closure = await resolveWorkflowPins(store, root, { rootResources: {} });
      const resolved = { ...context, ...closure.context };
      return { context: resolved, validation: validateWorkflowGraph(workflow, resolved) };
    } catch (error) {
      return { context, validation: { valid: false, launch_ready: false, errors: [{ code: error.code ?? 'DEPENDENCY_RESOLUTION_FAILED', message: error.message }], blockers: [], order: [] } };
    }
  }
  async open() {
    const config = await this.config();
    requireValue(config.version === 7, 'WORKFLOW_MIGRATION_REQUIRED', 'The user-owned configuration must migrate to v7 before Workflow execution');
    const context = { providers: config.providers, ...(this.capabilities.context ?? {}) };
    // Provider authority always comes from the actual user config, never probes.
    context.providers = config.providers;
    context.environment = Object.keys(this.env).filter(key => Boolean(this.env[key]));
    context.tools = [...new Set([...(context.tools ?? []), 'read_workflow_resource'])];
    const storeRoot = insideRoot(dirname(this.configPath), join(dirname(this.configPath), config.workflow_store.relative_path));
    await noSymlinks(storeRoot); // A missing migrated generation is corruption, not an empty new library.
    const store = await new WorkflowStore(storeRoot, { validationContext: context }).initialize();
    const runtime = await new WorkflowRuntime({ workflowStore: store, runRoot: join(dirname(this.configPath), 'workflow-runs'), context,
      parallelManager: this.parallelManager,
      strictCapability: this.capabilities.strictCapability ?? (async (pack, closure) => { await this.strictManager.capability(pack, config.providers, closure?.skills); return true; }),
      ...(this.capabilities.parallelWriteCapability ? { parallelWriteCapability: this.capabilities.parallelWriteCapability } : {}),
    }).initialize();
    const executor = new WorkflowExecutor({ runtime, getConfig: () => this.config(), registry: this.registry, strictManager: this.strictManager, env: this.env, fetchImpl: this.fetchImpl });
    return { config, context, store, runtime, executor };
  }
  async call(operation, args = {}, { human = false } = {}) {
    if (operation === 'migrate_v6') { requireValue(human, 'HUMAN_CONFIGURATION_REQUIRED', 'Migration is a user-owned console action'); await this.config(); return migrateV6OnDisk({ configPath: this.configPath }); }
    if (operation === 'restore_v6') { requireValue(human, 'HUMAN_CONFIGURATION_REQUIRED', 'Backup restoration is a user-owned console action'); return restoreV6Backup({ configPath: this.configPath, expected_current_sha256: args.expected_current_sha256 }); }
    const { config, context, store, runtime, executor } = await this.open();
    if (['start', 'claim_node', 'dispatch', 'retry_node', 'resume', 'prepare_integration', 'integrate_parallel'].includes(operation)) requireValue(config.global.enabled && !isEnvironmentDisabled(this.env), 'CONTROL_DISABLED', 'Workflow execution is disabled');
    switch (operation) {
      case 'skill_inventory': {
        return this.skillInventory.list(args.workspace);
      }
      case 'import_skill': {
        const selected = await this.skillInventory.select(args.workspace, args.skill_id);
        const provider = config.providers.find(provider => provider.id === args.provider_id);
        if (args.provider_id) requireValue(provider, 'PROVIDER_MISSING', 'Selected instruction Provider does not exist');
        return importCoarseSkill(store, selected.path, { id: args.workflow_id, name: args.name, providerId: args.provider_id, role: provider?.config?.role ?? 'advisor', expectedSourceHash: selected.source_hash });
      }
      case 'verify_relocation': {
        const pack = await store.snapshot(args.workflow_id, args.revision_hash);
        return verifyCoarseRelocation(pack, await store.resources(args.workflow_id, pack.revision_hash));
      }
      case 'import_review': return importReviewPacket(await store.snapshot(args.workflow_id, args.revision_hash));
      case 'inline_skill': return inlineSkillReference(store, args.workflow_id, args);
      case 'review_import': {
        requireValue(human, 'HUMAN_REVIEW_REQUIRED', 'Import and inference confirmation belongs to the human editor');
        return reviewImportedDraft(store, args.workflow_id, args);
      }
      case 'prepare_expansion': {
        requireValue(config.global.enabled && !isEnvironmentDisabled(this.env), 'CONTROL_DISABLED', 'Workflow expansion is disabled');
        const provider = config.providers.find(item => item.id === args.provider_id);
        const pack = await store.snapshot(args.workflow_id, args.revision_hash);
        const packet = expansionPacket(pack, await store.resources(args.workflow_id, pack.revision_hash), provider);
        const adapter = buildProviderAdapter(provider, { access: 'read_only' }, { env: this.env, allowDirectApi: config.global.allow_direct_api });
        // A packet is not an invocation. Native/MCP/Strict host integration must
        // preserve this selected Provider and record actual dispatch separately.
        return { ...packet, adapter, handoff_required: true, invoked: false, approval_required: provider.requires_user_approval };
      }
      case 'create_expansion_run': {
        requireValue(config.global.enabled && !isEnvironmentDisabled(this.env), 'CONTROL_DISABLED', 'Workflow expansion is disabled');
        const provider = config.providers.find(item => item.id === args.provider_id);
        const pack = await store.snapshot(args.workflow_id, args.revision_hash);
        const job = expansionRunPack(pack, await store.resources(args.workflow_id, pack.revision_hash), provider, args.run_id);
        await this.strictManager.capability({ ...job, resources: [{ path: 'analysis/request.txt', bytes: Buffer.byteLength(job.resources['analysis/request.txt']) }] }, config.providers);
        const jobs = await new WorkflowStore(join(dirname(this.configPath), 'workflow-expansion-jobs'), { validationContext: context }).initialize();
        const saved = await jobs.create(job.workflow, job);
        const planning = await new WorkflowRuntime({ workflowStore: jobs, runRoot: runtime.runs.root, context, strictCapability: async definition => { await this.strictManager.capability(definition, config.providers); return true; } }).initialize();
        return planning.start({ workflow_id: saved.workflow.id, revision_hash: saved.revision_hash, run_id: args.run_id,
          workspace: args.workspace, main_actor: args.main_actor, access: 'read_only', inputs: { task: 'Analyze this pinned Skill into an editable Draft' } });
      }
      case 'apply_expansion_result': {
        const state = await runtime.authorizeController(args.run_id, args);
        requireValue(state.status === 'succeeded', 'EXPANSION_ACCEPTANCE_REQUIRED', 'Expansion Run needs main-controller acceptance before applying its proposal');
        const { pins } = await runtime.runs.read(args.run_id); const provenance = pins.root.provenance;
        requireValue(provenance?.kind === 'skill_expansion_job' && provenance.source_workflow_id === args.workflow_id && provenance.source_revision === args.expected_revision,
          'EXPANSION_RESULT_IDENTITY', 'Expansion result belongs to a different source Workflow revision');
        return applyExpansion(store, args.workflow_id, state.nodes.expand.output, { expected_revision: args.expected_revision, context });
      }
      case 'apply_expansion': return applyExpansion(store, args.workflow_id, args.proposal, { expected_revision: args.expected_revision, context });
      case 'list': return Promise.all((await store.list()).map(async pack => ({ id: pack.workflow.id, name: pack.workflow.name, status: pack.workflow.status, enabled: pack.workflow.enabled, revision_hash: pack.revision_hash, description: pack.workflow.description, skill_policy: pack.workflow.skill_policy, validation: (await this.validationContext(store, pack.workflow, context)).validation })));
      case 'read': return store.snapshot(args.workflow_id, args.revision_hash);
      case 'validate': return (await this.validationContext(store, args.workflow, context)).validation;
      case 'create': {
        if (args.workflow.status === 'ready') {
          const checked = await this.validationContext(store, args.workflow, context);
          requireValue(checked.validation.valid, 'WORKFLOW_NOT_READY', 'Workflow dependencies or structure are invalid', { validation: checked.validation }); store.validationContext = checked.context;
        }
        return store.create(args.workflow, { resources: args.resources, provenance: args.provenance, import_report: args.import_report });
      }
      case 'save': {
        if (args.workflow.status === 'ready') {
          const checked = await this.validationContext(store, args.workflow, context);
          requireValue(checked.validation.valid, 'WORKFLOW_NOT_READY', 'Workflow dependencies or structure are invalid', { validation: checked.validation }); store.validationContext = checked.context;
        }
        return store.save(args.workflow_id, args.workflow, args);
      }
      case 'duplicate': return store.duplicate(args.workflow_id, args.new_id, args.name, args.revision_hash);
      case 'rename': return store.rename(args.workflow_id, args.name, args.expected_revision);
      case 'delete': return store.delete(args.workflow_id, args.expected_revision);
      case 'restore_revision': return store.restore(args.workflow_id, args.revision_hash, args.expected_revision);
      case 'export': {
        const pack = await store.snapshot(args.workflow_id, args.revision_hash); const resources = await store.resources(args.workflow_id, pack.revision_hash);
        return { format: 'sol-workflow-pack-v1', ...pack, resource_data: Object.fromEntries(Object.entries(resources).map(([path, bytes]) => [path, Buffer.from(bytes).toString('base64')])) };
      }
      case 'start': {
        const request = resolveLegacyWorkflowRequest(config, args);
        return runtime.start(request);
      }
      case 'runs': return runtime.runs.list();
      case 'get': return runtime.get(args.run_id);
      case 'next': return runtime.next(args.run_id);
      case 'claim_node': return runtime.claimNode(args.run_id, args);
      case 'complete_node': return runtime.completeNode(args.run_id, args);
      case 'fail_node': return runtime.failNode(args.run_id, args);
      case 'retry_node': return runtime.retryNode(args.run_id, args);
      case 'approve': return runtime.approve(args.run_id, args);
      case 'pause': return runtime.pause(args.run_id, args);
      case 'resume': return runtime.resume(args.run_id, args);
      case 'cancel': {
        let ids; const errors = [];
        try { ids = await runtime.cancelTree(args.run_id, args); }
        catch (error) { if (!error.fenced_run_ids) throw error; ids = error.fenced_run_ids; errors.push(error); }
        // An unreadable child journal cannot prevent shutdown of its exact
        // already-fenced owned session or the other independently known children.
        const stopped = await Promise.allSettled(ids.map(id => this.strictManager.stopRun(id)));
        errors.push(...stopped.filter(item => item.status === 'rejected').map(item => item.reason));
        if (errors.length) throw new AggregateError(errors, 'Run tree was fenced but some local sessions did not stop');
        return runtime.get(args.run_id);
      }
      case 'events': return runtime.events(args.run_id, args);
      case 'dispatch': return executor.dispatch(args.run_id, args);
      case 'strict_status': return this.strictManager.status(runtime, args.run_id, args);
      case 'strict_login': {
        requireValue(human, 'HUMAN_AUTHENTICATION_REQUIRED', 'Managed login URLs are available only to the authenticated human console');
        return this.strictManager.login(runtime, args.run_id, args);
      }
      case 'collect_strict': return this.strictManager.collect(runtime, args.run_id, args);
      case 'cleanup_strict_orphans': return this.strictManager.cleanupOrphans(runtime, args.run_id, args);
      case 'dispatch_receipt': return runtime.recordDispatchReceipt(args.run_id, args);
      case 'reconcile_connector': return executor.reconcileConnector(args.run_id, args);
      case 'collect_connector': return executor.collectConnector(args.run_id, args);
      case 'collect_subworkflow': return runtime.collectSubworkflow(args.run_id, args);
      case 'prepare_integration': return this.parallelManager.prepareIntegration(runtime, args.run_id, args);
      case 'review_integration': return this.parallelManager.review(runtime, args.run_id, args);
      case 'integrate_parallel': return this.parallelManager.integrate(runtime, args.run_id, args);
      case 'cleanup_parallel': return this.parallelManager.cleanup(runtime, args.run_id, args);
      default: throw Object.assign(new Error(`Unknown Workflow operation: ${operation}`), { code: 'WORKFLOW_OPERATION' });
    }
  }
}
