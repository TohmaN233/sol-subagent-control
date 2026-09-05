import { lstat, readFile, readdir, open, rename, unlink, realpath } from 'node:fs/promises';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resourcePath, requireValue, noSymlinks, insideRoot, canonicalNoLinks } from '../workflow-paths.mjs';
import { pathBoundaries } from '../workflow-bindings.mjs';
import { digest } from '../workflow-revisions.mjs';

const MAX_FILE = 1024 * 1024;
const key = path => process.platform === 'win32' ? path.toLowerCase() : path;
const within = (root, path) => key(path) === key(root) || key(path).startsWith(key(root) + sep);
const textResult = value => ({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] });
const schema = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string' };
function argsShape(args, names) {
  requireValue(args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).length === names.length && names.every(name => Object.hasOwn(args, name)), 'CODEX_TOOL_ARGUMENTS', 'Tool arguments must match the declared schema');
}

// All file access is performed by this host broker. No shell or arbitrary-path
// dynamic reader is exposed. This is an application boundary, not an OS ACL.
export async function createCodexToolBroker({ workspace, access, allowedPaths = [], deniedPaths = [], resources = [],
  authorize, onOperation,
}) {
  requireValue(['read_only', 'bounded_write'].includes(access) && typeof authorize === 'function' && typeof onOperation === 'function', 'CODEX_BROKER_AUTHORITY', 'The broker requires explicit access, a live lease check and a durable operation sink');
  await noSymlinks(workspace); const root = await realpath(workspace);
  const boundaries = pathBoundaries(allowedPaths).map(path => join(root, ...path.split('/')));
  requireValue(access !== 'bounded_write' || boundaries.length > 0, 'CODEX_BROKER_SCOPE', 'Write tools require concrete narrowed path boundaries');
  const denied = await Promise.all(deniedPaths.map(path => canonicalNoLinks(path)));
  const pinned = new Map();
  requireValue(resources.length <= 512, 'CODEX_RESOURCE_LIMIT', 'Too many node resources');
  let totalResourceBytes = 0;
  for (const item of resources) {
    const path = resourcePath(item.path); const bytes = Buffer.from(item.bytes);
    totalResourceBytes += bytes.length;
    requireValue(bytes.length <= MAX_FILE && totalResourceBytes <= 16 * MAX_FILE && !pinned.has(path) && digest(bytes) === item.sha256, 'CODEX_RESOURCE_PIN', 'Resource is duplicated, oversized or differs from its pin');
    pinned.set(path, { bytes, sha256: item.sha256 });
  }
  function locate(path, write = false, directory = false) {
    requireValue(typeof path === 'string', 'CODEX_TOOL_PATH', 'Tool path must be workspace-relative');
    const parts = directory && path === '.' ? [] : resourcePath(path).split('/');
    requireValue(!parts.some(part => ['.git', '.codex', '.agents', '.skills'].includes(part.toLowerCase()) || part.toLowerCase() === 'skill.md'), 'CODEX_TOOL_PATH_DENIED', 'Runtime configuration, Git internals and ambient Skills are not workspace tool inputs');
    const absolute = parts.length ? insideRoot(root, join(root, ...parts)) : root;
    requireValue(!denied.some(item => within(item, absolute)), 'CODEX_TOOL_PATH_DENIED', 'Path belongs to executor-owned or explicitly denied state');
    if (write) requireValue(access === 'bounded_write' && boundaries.some(item => within(item, absolute)), 'CODEX_TOOL_WRITE_DENIED', 'Write is outside this node permission intersection');
    return absolute;
  }
  async function regular(path) {
    await noSymlinks(path); const stat = await lstat(path);
    requireValue(stat.isFile() && stat.nlink === 1 && stat.size <= MAX_FILE, 'CODEX_TOOL_FILE', 'Only bounded regular files without hard links are supported');
    return stat;
  }
  function decode(bytes) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw Object.assign(new Error('File is not valid UTF-8 text'), { code: 'CODEX_TOOL_ENCODING' }); }
  }
  const tools = [
    { name: 'list_workspace', description: 'List one workspace directory, excluding runtime internals and ambient Skills. Use . for its root.', inputSchema: schema({ path: string }) },
    { name: 'read_workspace', description: 'Read a bounded UTF-8 workspace file and its SHA-256 for a later compare-and-swap write.', inputSchema: schema({ path: string }) },
    ...(access === 'bounded_write' ? [{ name: 'write_workspace', description: 'Atomically write UTF-8 text inside the node scope. expected_sha256 must match the current file; null creates a new file. Parent directory must exist.', inputSchema: schema({ path: string, text: string, expected_sha256: { type: ['string', 'null'] } }) }] : []),
    ...(pinned.size ? [{ name: 'read_workflow_resource', description: 'Read an immutable resource pinned to this node.', inputSchema: schema({ path: { type: 'string', enum: [...pinned.keys()] } }) }] : []),
  ];
  let queue = Promise.resolve(); let revoked = false;
  async function checkAuthority() {
    requireValue(!revoked, 'CODEX_BROKER_REVOKED', 'Workspace broker was revoked');
    await authorize(); requireValue(!revoked, 'CODEX_BROKER_REVOKED', 'Workspace broker was revoked during authorization');
  }
  async function perform(name, args, callId) {
    requireValue(tools.some(tool => tool.name === name) && typeof callId === 'string' && callId.length <= 256, 'CODEX_TOOL_DENIED', 'Tool is outside this node broker');
    await checkAuthority();
    argsShape(args, name === 'write_workspace' ? ['path', 'text', 'expected_sha256'] : ['path']);
    if (name === 'read_workflow_resource') {
      const item = pinned.get(args.path); requireValue(item, 'CODEX_RESOURCE_DENIED', 'Resource is outside the pinned node manifest');
      await onOperation({ call_id: callId, tool: name, path: args.path, phase: 'read', sha256: item.sha256 });
      return textResult({ path: args.path, sha256: item.sha256, text: decode(item.bytes) });
    }
    const path = locate(args.path, name === 'write_workspace', name === 'list_workspace');
    if (name === 'list_workspace') {
      await noSymlinks(path); requireValue((await lstat(path)).isDirectory(), 'CODEX_TOOL_DIRECTORY', 'Expected directory');
      const entries = await readdir(path, { withFileTypes: true });
      requireValue(entries.length <= 2000, 'CODEX_TOOL_DIRECTORY_LIMIT', 'Directory exceeds the qualified entry limit');
      const visible = [];
      for (const entry of entries) {
        if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) continue;
        const child = relative(root, join(path, entry.name)).split(sep).join('/');
        try { locate(child); } catch (error) { if (['CODEX_TOOL_PATH_DENIED', 'INVALID_RESOURCE_PATH'].includes(error.code)) continue; throw error; }
        visible.push({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' });
      }
      await onOperation({ call_id: callId, tool: name, path: args.path, phase: 'read', entries: visible.length });
      return textResult({ entries: visible.sort((a, b) => a.name.localeCompare(b.name, 'en')) });
    }
    if (name === 'read_workspace') {
      await regular(path); const bytes = await readFile(path);
      requireValue(bytes.length <= MAX_FILE, 'CODEX_TOOL_FILE', 'File grew beyond the read limit');
      const text = decode(bytes); const sha256 = digest(bytes);
      await onOperation({ call_id: callId, tool: name, path: args.path, phase: 'read', sha256 });
      return textResult({ path: args.path, sha256, text });
    }
    requireValue(typeof args.text === 'string' && Buffer.byteLength(args.text) <= MAX_FILE && (args.expected_sha256 === null || /^[a-f0-9]{64}$/.test(args.expected_sha256)), 'CODEX_TOOL_WRITE_ARGUMENTS', 'Write needs bounded text and an exact prior content hash or null');
    const parent = dirname(path); await noSymlinks(parent);
    let previous;
    try { await regular(path); previous = digest(await readFile(path)); } catch (error) { if (error.code !== 'ENOENT') throw error; previous = null; }
    requireValue(previous === args.expected_sha256, 'CODEX_TOOL_WRITE_CONFLICT', 'Workspace file changed since the caller observed it');
    const sha256 = digest(args.text); const operation = { call_id: callId, tool: name, path: args.path, before_sha256: previous, after_sha256: sha256 };
    await onOperation({ ...operation, phase: 'intent' }); await checkAuthority();
    const temporary = join(parent, '.sol-write-' + randomUUID()); let committed = false;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(args.text); await handle.sync(); } finally { await handle.close(); }
      await noSymlinks(parent);
      // Revalidate after the asynchronous durable intent. This serializes our
      // writer; concurrent external editors still need the worktree gate.
      let current;
      try { await regular(path); current = digest(await readFile(path)); } catch (error) { if (error.code !== 'ENOENT') throw error; current = null; }
      requireValue(current === previous, 'CODEX_TOOL_WRITE_CONFLICT', 'Workspace changed while preparing the write');
      await checkAuthority(); await rename(temporary, path); committed = true;
      await onOperation({ ...operation, phase: 'committed' });
      return textResult({ path: args.path, sha256 });
    } catch (error) {
      if (!committed) try { await unlink(temporary); } catch (cleanup) { if (cleanup.code !== 'ENOENT') throw new AggregateError([error, cleanup], 'Workspace write and temporary cleanup failed'); }
      if (committed) { error.committed = true; error.operation = operation; }
      throw error;
    }
  }
  return { tools: () => structuredClone(tools), revoke() { revoked = true; },
    async quiesce() {
      revoked = true;
      // Preserve the failure as an explicit shutdown outcome. The tool caller
      // also receives its original rejection; this only waits for it to settle.
      return queue.then(() => ({ quiescent: true, error: null }), error => ({ quiescent: true, error }));
    },
    call(name, args, callId) {
    const next = queue.then(() => perform(name, args, callId));
    // A failed operation poisons this broker. No subsequent tool may hide it.
    queue = next; return next;
  } };
}
