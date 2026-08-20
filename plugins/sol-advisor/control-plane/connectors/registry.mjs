import { ConnectorTaskStore, resolveConnectorTaskPath } from './task-store.mjs';
import { GrokAcpConnector } from './grok-acp.mjs';
import { connectorError } from './errors.mjs';

const registries = new Map();

export class ConnectorRegistry {
  constructor({ configPath, env = process.env, spawnImpl }) {
    this.configPath = configPath;
    this.env = env;
    this.store = new ConnectorTaskStore({ statePath: resolveConnectorTaskPath(configPath) });
    this.grok = new GrokAcpConnector({
      store: this.store,
      configPath,
      env,
      ...(spawnImpl ? { spawnImpl } : {}),
    });
  }

  async initialize() {
    await this.store.initialize();
    return this;
  }

  connector(provider) {
    if (provider.kind !== 'builtin_connector') {
      throw connectorError('PROVIDER_NOT_BUILTIN', `Provider is not a built-in connector: ${provider.id}`);
    }
    if (provider.config.connector === 'grok_acp') return this.grok;
    throw connectorError('CONNECTOR_UNSUPPORTED', `Unsupported built-in connector: ${provider.config.connector}`);
  }

  async probe(provider, args) {
    await this.initialize();
    return this.connector(provider).probe(provider, args);
  }

  async start(params) {
    await this.initialize();
    return this.connector(params.provider).start(params);
  }

  async status(taskId, waitMs) {
    await this.initialize();
    const task = await this.store.get(taskId);
    if (!task) throw connectorError('TASK_NOT_FOUND', `Unknown connector task: ${taskId}`);
    if (task.connector === 'grok_acp') return this.grok.status(taskId, waitMs);
    throw connectorError('CONNECTOR_UNSUPPORTED', `Unsupported task connector: ${task.connector}`);
  }

  async control(taskId, args) {
    await this.initialize();
    const task = await this.store.get(taskId);
    if (!task) throw connectorError('TASK_NOT_FOUND', `Unknown connector task: ${taskId}`);
    if (task.connector === 'grok_acp') return this.grok.control(taskId, args);
    throw connectorError('CONNECTOR_UNSUPPORTED', `Unsupported task connector: ${task.connector}`);
  }
}

export function connectorRegistryFor({ configPath, env = process.env }) {
  const key = `${configPath}\0${env.GROK_BIN || ''}`;
  if (!registries.has(key)) registries.set(key, new ConnectorRegistry({ configPath, env }));
  return registries.get(key);
}
