#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const files = [
  'config.test.mjs',
  'connector-integration.test.mjs',
  'connectors.test.mjs',
  'console.test.mjs',
  'mcp.test.mjs',
  'open-console.test.mjs',
  'providers.test.mjs',
  'workflow-store.test.mjs',
  'workflow-editor.test.mjs',
  'workflow-validator.test.mjs',
  'workflow-migration.test.mjs',
  'workflow-runtime.test.mjs',
  'workflow-pins.test.mjs',
  'workflow-subworkflow.test.mjs',
  'parallel-planner.test.mjs',
  'parallel-worktrees.test.mjs',
  'parallel-runtime.test.mjs',
  'workflow-service.test.mjs',
  'strict-execution.test.mjs',
  'codex-tool-broker.test.mjs',
  'codex-managed-login.test.mjs',
  'strict-manager.test.mjs',
  'skill-import.test.mjs',
].map((name) => join(root, name));

const child = spawn(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
  windowsHide: true,
  env: process.env,
});
child.once('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (signal) console.error(`test runner terminated by ${signal}`);
  process.exitCode = Number.isInteger(code) ? code : 1;
});
