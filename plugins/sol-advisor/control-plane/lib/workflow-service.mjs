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

export class WorkflowService {
  constructor({ configPath, defaultConfigPath, env = process.env, fetchImpl = globalThis.fetch, registry, capabilities = {} }) {
    this.configPath = resolve(configPath); this.defaultConfigPath = defaultConfigPath; this.env = env; this.fetchImpl = fetchImpl;
    this.registry = registry ?? connectorRegistryFor({ configPath: this.configPath, env }); this.capabilities = capabilities;
    this.strictManager = capabilities.strictManager ?? strictManagerFor({ configPath: this.configPath, getConfig: () => this.config(), env });
  }
  async config() { return loadConfig({ configPath: this.configPath, defaultConfigPath: this.defaultConfigPath }); }
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
      strictCapability: this.capabilities.strictCapability ?? (async pack => { await this.strictManager.capability(pack, config.providers); return true; }),
      ...(this.capabilities.parallelWriteCapability ? { parallelWriteCapability: this.capabilities.parallelWriteCapability } : {}),
    }).initialize();
    const executor = new WorkflowExecutor({ runtime, getConfig: () => this.config(), registry: this.registry, strictManager: this.strictManager, env: this.env, fetchImpl: this.fetchImpl });
    return { config, context, store, runtime, executor };
  }
  async call(operation, args = {}, { human = false } = {}) {
    if (operation === 'migrate_v6') { requireValue(human, 'HUMAN_CONFIGURATION_REQUIRED', 'Migration is a user-owned console action'); await this.config(); return migrateV6OnDisk({ configPath: this.configPath }); }
    if (operation === 'restore_v6') { requireValue(human, 'HUMAN_CONFIGURATION_REQUIRED', 'Backup restoration is a user-owned console action'); return restoreV6Backup({ configPath: this.configPath, expected_current_sha256: args.expected_current_sha256 }); }
    const { config, context, store, runtime, executor } = await this.open();
    if (['start', 'claim_node', 'dispatch', 'retry_node', 'resume'].includes(operation)) requireValue(config.global.enabled && !isEnvironmentDisabled(this.env), 'CONTROL_DISABLED', 'Workflow execution is disabled');
    switch (operation) {
      case 'skill_inventory': {
        requireValue(this.capabilities.skillInventory, 'SKILL_DISCOVERY_UNAVAILABLE', 'Actual host Skill discovery is not configured');
        return this.capabilities.skillInventory.list(args.workspace);
      }
      case 'import_skill': {
        requireValue(this.capabilities.skillInventory, 'SKILL_DISCOVERY_UNAVAILABLE', 'Actual host Skill discovery is not configured');
        const selected = await this.capabilities.skillInventory.select(args.workspace, args.skill_id);
        const provider = config.providers.find(provider => provider.id === args.provider_id);
        if (args.provider_id) requireValue(provider, 'PROVIDER_MISSING', 'Selected instruction Provider does not exist');
        return importCoarseSkill(store, selected.path, { id: args.workflow_id, name: args.name, providerId: args.provider_id, role: provider?.config?.role ?? 'advisor', expectedSourceHash: selected.source_hash });
      }
      case 'verify_relocation': {
        const pack = await store.snapshot(args.workflow_id, args.revision_hash);
        return verifyCoarseRelocation(pack, await store.resources(args.workflow_id, pack.revision_hash));
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
      case 'apply_expansion': return applyExpansion(store, args.workflow_id, args.proposal, { expected_revision: args.expected_revision, context });
      case 'list': return Promise.all((await store.list()).map(async pack => ({ id: pack.workflow.id, name: pack.workflow.name, status: pack.workflow.status, enabled: pack.workflow.enabled, revision_hash: pack.revision_hash, description: pack.workflow.description, skill_policy: pack.workflow.skill_policy, validation: validateWorkflowGraph(pack.workflow, context) })));
      case 'read': return store.snapshot(args.workflow_id, args.revision_hash);
      case 'validate': return validateWorkflowGraph(args.workflow, context);
      case 'create': return store.create(args.workflow, { resources: args.resources, provenance: args.provenance, import_report: args.import_report });
      case 'save': return store.save(args.workflow_id, args.workflow, args);
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
        await runtime.cancel(args.run_id, args); // Fence leases before waiting for local tools/processes.
        await this.strictManager.stopRun(args.run_id);
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
      default: throw Object.assign(new Error(`Unknown Workflow operation: ${operation}`), { code: 'WORKFLOW_OPERATION' });
    }
  }
}
