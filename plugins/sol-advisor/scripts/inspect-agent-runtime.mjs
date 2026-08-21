#!/usr/bin/env node

import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function usage() {
  process.stderr.write(`Usage: inspect-agent-runtime.mjs [--sessions-dir DIR] THREAD_ID\n\nRead the one rollout file whose filename ends with THREAD_ID and emit a compact\nJSON object containing only safe routing metadata. Without --sessions-dir, the\nsessions root is CODEX_HOME/sessions when CODEX_HOME is set, otherwise the\nplatform Codex home under the current user's home directory.\n`);
}

function fatal(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  throw error;
}

function parseArguments(argv) {
  let sessionsDir;
  let threadId;

  if (argv.length === 1) {
    [threadId] = argv;
  } else if (argv.length === 3 && argv[0] === '--sessions-dir') {
    sessionsDir = argv[1];
    threadId = argv[2];
    if (!sessionsDir) fatal('--sessions-dir requires a non-empty directory.');
  } else {
    usage();
    fatal('invalid arguments.', 2);
  }

  if (!uuidPattern.test(threadId)) fatal('THREAD_ID must be a lowercase UUID.');
  if (!sessionsDir) {
    sessionsDir = process.env.CODEX_HOME
      ? join(process.env.CODEX_HOME, 'sessions')
      : join(homedir(), '.codex', 'sessions');
  }
  return { sessionsDir, threadId };
}

function enumerateRollouts(sessionsDir, threadId) {
  let rootStat;
  try {
    rootStat = lstatSync(sessionsDir);
  } catch {
    fatal('sessions directory is unavailable.');
  }
  if (!rootStat.isDirectory()) fatal('sessions directory is unavailable.');

  const suffix = `-${threadId}.jsonl`;
  const matches = [];
  const pending = [sessionsDir];
  while (pending.length > 0) {
    const directory = pending.pop();
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      fatal('could not enumerate rollout filenames under the sessions directory.');
    }
    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(suffix)) {
        matches.push(entryPath);
      }
    }
  }
  return matches;
}

function stringOrNull(value) {
  return typeof value === 'string' ? value : null;
}

function unique(values) {
  return [...new Set(values)];
}

function requiredConsistent(values, missingMessage, conflictMessage) {
  if (values.some((value) => value === null || value === '')) fatal(missingMessage);
  if (unique(values).length !== 1) fatal(conflictMessage);
  return values[0];
}

function consistent(values, conflictMessage) {
  if (unique(values).length !== 1) fatal(conflictMessage);
  return values[0];
}

function inspectRollout(rolloutFile, expectedThreadId) {
  let records;
  try {
    records = readFileSync(rolloutFile, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
  } catch {
    fatal('rollout is missing, ambiguous, invalid, or inconsistent required routing metadata.');
  }

  const sessions = records.filter((record) => record?.type === 'session_meta').map((record) => record.payload);
  const turns = records.filter((record) => record?.type === 'turn_context').map((record) => record.payload);
  if (sessions.length !== 1 || turns.length === 0) {
    fatal('rollout is missing, ambiguous, invalid, or inconsistent required routing metadata.');
  }

  try {
    const session = sessions[0] ?? {};
    const threadId = stringOrNull(session.id);
    const agentRole = stringOrNull(session.agent_role);
    if (threadId !== expectedThreadId) fatal('session metadata does not identify the requested thread.');
    if (!agentRole) fatal('missing agent role.');

    const model = requiredConsistent(
      turns.map((turn) => stringOrNull(turn?.model)),
      'missing model.',
      'conflicting models.',
    );
    const effort = requiredConsistent(
      turns.map((turn) => stringOrNull(turn?.effort)),
      'missing effort.',
      'conflicting efforts.',
    );
    const sandboxPolicyType = consistent(
      turns.map((turn) => stringOrNull(turn?.sandbox_policy?.type)),
      'conflicting sandbox policy types.',
    );
    const permissionProfileType = consistent(
      turns.map((turn) => stringOrNull(turn?.permission_profile?.type)),
      'conflicting permission profile types.',
    );
    const cwd = consistent(
      turns.map((turn) => stringOrNull(turn?.cwd)),
      'conflicting working directories.',
    );

    return {
      thread_id: threadId,
      parent_thread_id: stringOrNull(session.parent_thread_id),
      agent_role: agentRole,
      agent_path: stringOrNull(session.agent_path),
      model_provider: stringOrNull(session.model_provider),
      model,
      effort,
      sandbox_policy_type: sandboxPolicyType,
      permission_profile_type: permissionProfileType,
      cwd,
    };
  } catch {
    fatal('rollout is missing, ambiguous, invalid, or inconsistent required routing metadata.');
  }
}

try {
  const { sessionsDir, threadId } = parseArguments(process.argv.slice(2));
  const matches = enumerateRollouts(sessionsDir, threadId);
  if (matches.length === 0) fatal('no rollout filename matched the requested thread id.');
  if (matches.length > 1) fatal('multiple rollout filenames matched the requested thread id.');
  process.stdout.write(`${JSON.stringify(inspectRollout(matches[0], threadId))}\n`);
} catch (error) {
  process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = error?.exitCode ?? 1;
}
