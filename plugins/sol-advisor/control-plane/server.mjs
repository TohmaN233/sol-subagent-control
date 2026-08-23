#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import readline from 'node:readline';

import {
  appendAuditEvent,
  configRevision,
  loadConfig,
  resolveConfigPath,
  saveConfig,
  validateConfig,
} from './lib/config.mjs';
import {
  controlConnectorTask,
  getConnectorTask,
  getControlStatus,
  invokeSelection,
  probeConnector,
  resolveSelection,
  startConnectorSelection,
} from './lib/control.mjs';

const CONTROL_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = join(CONTROL_DIR, 'default-config.json');
const WEB_DIR = join(CONTROL_DIR, 'web');
const SERVER_VERSION = '0.4.5';
const DEFAULT_CONSOLE_PORT = 58712;
const MAX_HTTP_BODY = 512 * 1024;

let consoleState = null;

function samePath(left, right) {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  return process.platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function textToolResult(value, isError = false) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  };
}

function errorToolPayload(error) {
  return {
    error: error instanceof Error ? error.message : String(error),
    ...(typeof error?.code === 'string' ? { code: error.code } : {}),
    ...(error?.retryable === true ? { retryable: true } : {}),
    ...(error?.actionRequired ? { action_required: error.actionRequired } : {}),
    ...(error?.details && typeof error.details === 'object' ? { details: error.details } : {}),
  };
}

function jsonResponse(res, status, value, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

function staticResponse(res, body, contentType) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': data.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
  });
  res.end(data);
}

function requestHostIsLoopback(req) {
  const host = String(req.headers.host || '').toLowerCase();
  return /^127\.0\.0\.1:\d+$/.test(host)
    || /^localhost:\d+$/.test(host)
    || /^\[::1\]:\d+$/.test(host);
}

function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_HTTP_BODY) throw new Error(`request body exceeds ${MAX_HTTP_BODY} bytes`);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text || '{}');
  } catch (error) {
    throw new Error(`invalid JSON body: ${error.message}`);
  }
}

function openBrowser(url, platform = process.platform) {
  let command;
  let args;
  if (platform === 'win32') {
    command = 'cmd.exe';
    args = ['/d', '/s', '/c', 'start', '', url];
  } else if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  return new Promise((resolve) => {
    let settled = false;
    try {
      const child = spawn(command, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.once('error', (error) => {
        if (!settled) {
          settled = true;
          resolve({ opened: false, error: error.message });
        }
      });
      child.once('spawn', () => {
        child.unref();
        if (!settled) {
          settled = true;
          resolve({ opened: true, error: null });
        }
      });
    } catch (error) {
      resolve({ opened: false, error: error.message });
    }
  });
}

export async function startConsole({
  configPath: requestedConfigPath,
  defaultConfigPath = DEFAULT_CONFIG_PATH,
  port = 0,
  open = true,
  env = process.env,
} = {}) {
  if (consoleState) {
    const opened = open ? await openBrowser(consoleState.url) : { opened: false, error: null };
    return { ...consoleState, browser: opened };
  }
  const configPath = requestedConfigPath || resolveConfigPath(env);
  const globalConfigPath = resolveConfigPath({ ...env, SOL_CONTROL_CONFIG: '' });
  const usesOverride = Boolean(env.SOL_CONTROL_CONFIG)
    || Boolean(requestedConfigPath && !samePath(configPath, globalConfigPath));
  const storage = {
    scope: usesOverride ? 'override' : 'global',
    config_path: configPath,
  };
  await loadConfig({ configPath, defaultConfigPath });
  const token = randomBytes(32).toString('base64url');
  const staticFiles = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/index.html': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  };

  const server = createServer(async (req, res) => {
    try {
      if (!requestHostIsLoopback(req)) {
        jsonResponse(res, 403, { error: 'loopback Host header required' });
        return;
      }
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method === 'GET' && staticFiles[url.pathname]) {
        const [fileName, contentType] = staticFiles[url.pathname];
        staticResponse(res, await readFile(join(WEB_DIR, fileName)), contentType);
        return;
      }
      if (url.pathname === '/health' && req.method === 'GET') {
        jsonResponse(res, 200, { status: 'ok', version: SERVER_VERSION });
        return;
      }
      if (!url.pathname.startsWith('/api/')) {
        jsonResponse(res, 404, { error: 'not found' });
        return;
      }
      if (bearerToken(req) !== token) {
        jsonResponse(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
        return;
      }
      if (url.pathname === '/api/config' && req.method === 'GET') {
        const config = await loadConfig({ configPath, defaultConfigPath });
        jsonResponse(res, 200, { config, revision: configRevision(config), storage });
        return;
      }
      if (url.pathname === '/api/config' && req.method === 'PUT') {
        const body = await readJsonBody(req);
        const saved = await saveConfig(body.config, {
          configPath,
          expectedRevision: String(body.expected_revision || ''),
        });
        await appendAuditEvent(configPath, {
          event: 'console-save',
          outcome: 'ok',
        }).catch(() => {});
        jsonResponse(res, 200, saved);
        return;
      }
      if (url.pathname === '/api/defaults' && req.method === 'GET') {
        const defaults = validateConfig(JSON.parse(await readFile(defaultConfigPath, 'utf8')));
        jsonResponse(res, 200, { config: defaults, revision: configRevision(defaults) });
        return;
      }
      jsonResponse(res, 404, { error: 'not found' });
    } catch (error) {
      const status = /changed since/.test(error.message) ? 409 : 400;
      jsonResponse(res, status, { error: error.message });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const url = `http://127.0.0.1:${actualPort}/#token=${encodeURIComponent(token)}`;
  consoleState = { server, token, url, port: actualPort, configPath, defaultConfigPath, storage, env };
  const browser = open ? await openBrowser(url) : { opened: false, error: null };
  await appendAuditEvent(configPath, {
    event: 'console-open',
    outcome: browser.opened || !open ? 'ok' : 'browser-error',
    detail: browser.error || '',
  }).catch(() => {});
  return { ...consoleState, browser };
}

export async function stopConsole() {
  if (!consoleState) return;
  const state = consoleState;
  consoleState = null;
  await new Promise((resolve) => state.server.close(resolve));
}

export function buildToolDefinitions() {
  const sharedResolveProperties = {
    task_type_id: { type: 'string', description: 'Exact enabled Task Type id returned by sol_control_status.' },
    task: { type: 'string', description: 'Task objective for the selected Task Type.' },
    context: { description: 'Relevant task context. String or JSON value.' },
    constraints: { description: 'Fixed decisions, scope boundaries, prohibited actions, and ownership.' },
    verification: { description: 'Concrete checks and acceptance evidence.' },
    user_approved: { type: 'boolean', default: false, description: 'Set true only after explicit current-task approval when the selected Provider or Stage approval gate is enabled.' },
  };
  return [
    {
      name: 'sol_control_status',
      description: 'Read sanitized control-plane metadata only: enabled Providers, Task Type ids, routes, ordered Stage bindings, capabilities, and approval flags. Prompt templates, provider endpoints, credential variable names, and console tokens are never returned.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'sol_control_console',
      description: 'Open the human-owned loopback configuration console in the default browser. The normal result does not reveal the console token or prompt library to the model. Use reveal_url only after an explicit user request for the manual URL.',
      inputSchema: {
        type: 'object',
        properties: {
          port: { type: 'integer', minimum: 0, maximum: 65535, default: DEFAULT_CONSOLE_PORT },
          reveal_url: { type: 'boolean', default: false },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'sol_control_resolve',
      description: 'After Sol selects exactly one enabled Task Type, compile only its ordered Stages and return each user-pinned Provider adapter contract. Sol must not substitute or fall back to another Provider. Native/MCP/web-review Providers are executed by Codex through their returned contracts; this tool does not invoke them.',
      inputSchema: {
        type: 'object',
        properties: sharedResolveProperties,
        required: ['task_type_id', 'task'],
        additionalProperties: false,
      },
    },
    {
      name: 'sol_connector_probe',
      description: 'Probe one enabled built-in connector without sending a task. A successful probe means the local binary/configuration is available; it does not claim a live model session.',
      inputSchema: {
        type: 'object',
        properties: {
          provider_id: { type: 'string' },
          workspace: { type: 'string', description: 'Optional absolute workspace path to validate.' },
        },
        required: ['provider_id'],
        additionalProperties: false,
      },
    },
    {
      name: 'sol_connector_start',
      description: 'Compile and internally deliver exactly one Stage from a selected Task Type to its pinned built-in connector. Bounded-write Stages require non-empty workspace-relative allowed_paths; extra confirmation is required only when the Provider or Stage approval gate is enabled.',
      inputSchema: {
        type: 'object',
        properties: {
          ...sharedResolveProperties,
          stage_id: { type: 'string', description: 'Exact Stage id returned for the selected Task Type.' },
          workspace: { type: 'string', description: 'Absolute existing Git repository root.' },
          allowed_paths: { type: 'array', items: { type: 'string' }, description: 'Required non-empty workspace-relative path boundaries for bounded-write Stages; omit for read-only Stages.' },
        },
        required: ['task_type_id', 'stage_id', 'task', 'workspace'],
        additionalProperties: false,
      },
    },
    {
      name: 'sol_connector_status',
      description: 'Read one exact connector task by task_id, optionally waiting up to 25 seconds for a state change. Never infer identity from the visible UI or latest session.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          wait_ms: { type: 'integer', minimum: 0, maximum: 25000, default: 0 },
        },
        required: ['task_id'],
        additionalProperties: false,
      },
    },
    {
      name: 'sol_connector_control',
      description: 'Control one exact connector task. Reconcile reattaches only persisted identities; Grok cancel requires exact session_id/run_id and Cursor cancel requires exact agent_id; abandon is explicitly risk-acknowledged.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          action: { type: 'string', enum: ['reconcile', 'respond_permission', 'respond_input', 'cancel', 'disconnect', 'abandon'] },
          request_id: { type: 'string' },
          decision: { type: 'string', enum: ['select', 'accept', 'decline', 'cancel'] },
          option_id: { type: 'string' },
          content: { type: 'object' },
          expected_session_id: { type: 'string' },
          expected_run_id: { type: 'string' },
          expected_agent_id: { type: 'string' },
          confirm: { type: 'boolean', default: false },
          acknowledge_may_still_run: { type: 'boolean', default: false },
          reason: { type: 'string' },
        },
        required: ['task_id', 'action'],
        additionalProperties: false,
      },
    },
    {
      name: 'sol_control_invoke',
      description: 'Resolve and directly call one enabled OpenAI-compatible advisory Provider pinned to a read-only Stage. Direct API invocation must be enabled in the console, credentials must exist only in the configured environment variable, and approval gates still apply. This tool never grants file or host tools to the external model.',
      inputSchema: {
        type: 'object',
        properties: {
          ...sharedResolveProperties,
          stage_id: { type: 'string', description: 'Exact read-only Stage id to invoke.' },
        },
        required: ['task_type_id', 'stage_id', 'task'],
        additionalProperties: false,
      },
    },
  ];
}

export async function handleRpc(request, {
  configPath = resolveConfigPath(),
  defaultConfigPath = DEFAULT_CONFIG_PATH,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const method = String(request?.method || '');
  const id = request?.id;
  if (method === 'server/discover') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2026-07-28',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'sol-control-plane', version: SERVER_VERSION },
      },
    };
  }
  if (method === 'initialize') {
    const requestedVersion = String(request?.params?.protocolVersion || '');
    const legacyVersions = new Set(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: legacyVersions.has(requestedVersion) ? requestedVersion : '2025-11-25',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'sol-control-plane', version: SERVER_VERSION },
      },
    };
  }
  if (method === 'notifications/initialized') return null;
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: buildToolDefinitions() } };
  }
  if (method === 'tools/call') {
    const params = request.params && typeof request.params === 'object' ? request.params : {};
    const name = String(params.name || '');
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    try {
      if (name === 'sol_control_status') {
        const status = await getControlStatus({ configPath, defaultConfigPath, env });
        return { jsonrpc: '2.0', id, result: textToolResult(status) };
      }
      if (name === 'sol_control_console') {
        const revealUrl = args.reveal_url === true;
        const state = await startConsole({
          configPath,
          defaultConfigPath,
          port: Number.isInteger(args.port) ? args.port : DEFAULT_CONSOLE_PORT,
          open: true,
          env,
        });
        const result = {
          console_opened: state.browser.opened,
          port: state.port,
          config_location: 'user state outside the plugin cache',
          message: state.browser.opened
            ? 'The Sol Subagent Control console was opened in the default browser.'
            : `The console is running, but the browser could not be opened automatically: ${state.browser.error || 'unknown error'}`,
          ...(revealUrl ? { console_url: state.url } : {}),
        };
        return { jsonrpc: '2.0', id, result: textToolResult(result) };
      }
      if (name === 'sol_control_resolve') {
        const { result } = await resolveSelection(args, {
          configPath,
          defaultConfigPath,
          env,
        });
        return { jsonrpc: '2.0', id, result: textToolResult(result) };
      }
      if (name === 'sol_connector_probe') {
        const result = await probeConnector(args, { configPath, defaultConfigPath, env });
        return { jsonrpc: '2.0', id, result: textToolResult(result) };
      }
      if (name === 'sol_connector_start') {
        const result = await startConnectorSelection(args, { configPath, defaultConfigPath, env });
        return { jsonrpc: '2.0', id, result: textToolResult(result) };
      }
      if (name === 'sol_connector_status') {
        const result = await getConnectorTask(args, { configPath, env });
        return { jsonrpc: '2.0', id, result: textToolResult(result) };
      }
      if (name === 'sol_connector_control') {
        const result = await controlConnectorTask(args, { configPath, env });
        return { jsonrpc: '2.0', id, result: textToolResult(result) };
      }
      if (name === 'sol_control_invoke') {
        const result = await invokeSelection(args, {
          configPath,
          defaultConfigPath,
          env,
          fetchImpl,
        });
        return { jsonrpc: '2.0', id, result: textToolResult(result) };
      }
      throw new Error(`unknown tool: ${name}`);
    } catch (error) {
      return { jsonrpc: '2.0', id, result: textToolResult(errorToolPayload(error), true) };
    }
  }
  if (id === undefined || id === null) return null;
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `method not found: ${method}` },
  };
}

async function main() {
  const configPath = resolveConfigPath();
  const reader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of reader) {
    if (!line.trim()) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch (error) {
      process.stderr.write(`sol-control-plane invalid JSON-RPC input: ${error.message}\n`);
      continue;
    }
    const response = await handleRpc(request, { configPath, defaultConfigPath: DEFAULT_CONFIG_PATH });
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
  await stopConsole();
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  process.on('SIGINT', () => {
    void stopConsole().finally(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void stopConsole().finally(() => process.exit(0));
  });
  main().catch((error) => {
    process.stderr.write(`sol-control-plane fatal error: ${error.stack || error.message}\n`);
    process.exit(1);
  });
}

export { CONTROL_DIR, DEFAULT_CONFIG_PATH, DEFAULT_CONSOLE_PORT, SERVER_VERSION };
