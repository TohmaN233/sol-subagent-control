import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readFile, readlink, realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import { connectorError } from './errors.mjs';

const execFileAsync = promisify(execFile);

async function git(workspace, args) {
  try {
    const result = await execFileAsync('git', ['-C', workspace, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return result.stdout || '';
  } catch (error) {
    throw connectorError('WORKSPACE_NOT_GIT',
      `Read-only connector work requires a Git repository: ${error.message}`,
      { actionRequired: 'Initialize Git or use a packet/API advisory provider.' });
  }
}

function samePath(left, right) {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

async function hashUntracked(workspace, paths) {
  const hash = createHash('sha256');
  for (const relative of paths.sort()) {
    const absolute = resolve(workspace, relative);
    const info = await lstat(absolute);
    hash.update(relative);
    hash.update(String(info.mode));
    if (info.isSymbolicLink()) {
      hash.update('symlink');
      hash.update(await readlink(absolute));
    } else if (info.isFile()) {
      hash.update(await readFile(absolute));
    } else {
      hash.update(info.isDirectory() ? 'directory' : 'other');
    }
  }
  return hash.digest('hex');
}

export async function validateWorkspace(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw connectorError('WORKSPACE_INVALID', 'workspace must be an absolute existing directory');
  }
  const requested = resolve(value);
  const info = await stat(requested).catch(() => null);
  if (!info?.isDirectory()) {
    throw connectorError('WORKSPACE_INVALID', `workspace is not an existing directory: ${requested}`);
  }
  return realpath(requested);
}

export async function captureReadOnlySnapshot(workspace) {
  const canonicalWorkspace = await realpath(workspace);
  const topLevelRaw = (await git(canonicalWorkspace, ['rev-parse', '--show-toplevel'])).trim();
  const topLevel = await realpath(topLevelRaw);
  if (!samePath(topLevel, canonicalWorkspace)) {
    throw connectorError('WORKSPACE_NOT_GIT_ROOT',
      `workspace must be the Git repository root: ${topLevel}`,
      { actionRequired: 'Select the repository root rather than a nested directory.' });
  }
  const diff = await git(canonicalWorkspace, ['diff', '--binary', 'HEAD', '--']);
  const untrackedRaw = await git(canonicalWorkspace, ['ls-files', '--others', '--exclude-standard', '-z', '--']);
  const untracked = untrackedRaw.split('\0').filter(Boolean);
  const untrackedDigest = await hashUntracked(canonicalWorkspace, untracked);
  return createHash('sha256')
    .update(diff)
    .update('\0')
    .update(untracked.join('\0'))
    .update('\0')
    .update(untrackedDigest)
    .digest('hex');
}

export async function verifyReadOnlySnapshot(workspace, baselineDigest) {
  const observed = await captureReadOnlySnapshot(workspace);
  return { unchanged: observed === baselineDigest, baseline_digest: baselineDigest, observed_digest: observed };
}
