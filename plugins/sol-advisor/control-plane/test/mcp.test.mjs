import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import test from 'node:test';

const controlDir = dirname(dirname(fileURLToPath(import.meta.url)));
const pluginDir = dirname(controlDir);
const serverPath = join(controlDir, 'server.mjs');

test('plugin MCP launches from the installed plugin root with the global Codex environment', async () => {
  const manifest = JSON.parse(await readFile(join(pluginDir, '.mcp.json'), 'utf8'));
  const server = manifest.mcpServers['sol-control-plane'];
  assert.equal(server.enabled, true);
  assert.equal(server.cwd, '.');
  assert.deepEqual(server.args, ['./control-plane/server.mjs']);
  assert.ok(server.env_vars.includes('CODEX_HOME'));
  assert.ok(server.env_vars.includes('USERPROFILE'));
});

test('routing policy warns on unobservable root metadata and never auto-falls back', async () => {
  const controlSkill = await readFile(join(pluginDir, 'skills', 'control-plane', 'SKILL.md'), 'utf8');
  const nativeSkill = await readFile(join(pluginDir, 'skills', 'orchestration', 'SKILL.md'), 'utf8');
  assert.doesNotMatch(controlSkill, /use the native[\s\S]{0,100}workflow or stay solo/i);
  assert.match(controlSkill, /request\s+permission[\s\S]{0,100}retry once/i);
  assert.doesNotMatch(nativeSkill, /ask the user to confirm[\s\S]{0,80}stop[\s\S]{0,40}until confirmed/i);
  assert.match(nativeSkill, /non-blocking reminder/i);
});

function makeClient(child) {
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    const resolver = pending.get(message.id);
    if (resolver) {
      pending.delete(message.id);
      resolver(message);
    }
  });
  return {
    request(message) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(message.id);
          reject(new Error(`timeout waiting for ${message.id}`));
        }, 5000);
        pending.set(message.id, (response) => {
          clearTimeout(timer);
          resolve(response);
        });
        child.stdin.write(`${JSON.stringify(message)}\n`);
      });
    },
  };
}

test('stdio MCP lists control tools and returns sanitized status', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sol-control-mcp-'));
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, SOL_CONTROL_CONFIG: join(dir, 'control-plane.json') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => {
    child.stdin.end();
    child.kill('SIGTERM');
  });
  const client = makeClient(child);
  const discovered = await client.request({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} });
  assert.equal(discovered.result.protocolVersion, '2026-07-28');
  assert.equal(discovered.result.serverInfo.name, 'sol-control-plane');

  const initialized = await client.request({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
  assert.equal(initialized.result.protocolVersion, '2025-11-25');

  const listed = await client.request({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
  const names = listed.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, ['sol_control_status', 'sol_control_console', 'sol_control_resolve', 'sol_connector_probe', 'sol_connector_start', 'sol_connector_status', 'sol_connector_control', 'sol_control_invoke']);
  const resolveTool = listed.result.tools.find((tool) => tool.name === 'sol_control_resolve');
  assert.deepEqual(resolveTool.inputSchema.required, ['task_type_id', 'task']);
  assert.equal('scenario_id' in resolveTool.inputSchema.properties, false);
  const startTool = listed.result.tools.find((tool) => tool.name === 'sol_connector_start');
  assert.ok(startTool.inputSchema.required.includes('stage_id'));

  const statusResponse = await client.request({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'sol_control_status', arguments: {} },
  });
  const status = JSON.parse(statusResponse.result.content[0].text);
  assert.equal(status.effective_enabled, true);
  assert.ok(status.task_types.some((taskType) => taskType.id === 'bounded-code-change'));
  assert.doesNotMatch(statusResponse.result.content[0].text, /CONSTRAINTS AND OWNERSHIP/);
  assert.doesNotMatch(statusResponse.result.content[0].text, /example\.invalid/);

  const connectorError = await client.request({
    jsonrpc: '2.0', id: 5, method: 'tools/call', params: {
      name: 'sol_connector_status', arguments: { task_id: 'missing-task' },
    },
  });
  assert.equal(connectorError.result.isError, true);
  const errorPayload = JSON.parse(connectorError.result.content[0].text);
  assert.equal(errorPayload.code, 'TASK_NOT_FOUND');
  assert.match(errorPayload.error, /Unknown connector task/);
});
