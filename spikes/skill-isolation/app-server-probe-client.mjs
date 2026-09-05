import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// Probe-only client: intentionally no thread/start, turn/start, auth, or provider calls.
const METHODS = new Set(['initialize', 'skills/list', 'skills/config/write']);

export function createProbeClient(binary, { home, cwd }) {
  const child = spawn(binary, ['app-server', '--stdio'], {
    env: { ...process.env, CODEX_HOME: home }, cwd, windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'], shell: false,
  });
  const pending = new Map();
  let nextId = 1;
  let fatal;
  let closed = false;
  let stderrBytes = 0;
  const closePromise = new Promise(resolve => child.once('close', () => { closed = true; resolve(); }));
  function fail(error) {
    fatal = error;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  }
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.stdout.on('error', fail);
  child.stderr.on('data', data => { stderrBytes += data.length; });
  child.on('exit', (code, signal) => fail(new Error(`App Server exited: code=${code}, signal=${signal}, stderr_bytes=${stderrBytes}`)));
  createInterface({ input: child.stdout }).on('line', line => {
    let message;
    try { message = JSON.parse(line); }
    catch { fail(new Error('Invalid App Server JSON')); child.kill(); return; }
    if (message.method && Object.hasOwn(message, 'id')) {
      fail(new Error('Unexpected App Server request in metadata-only probe'));
      child.kill();
      return;
    }
    if (!Object.hasOwn(message, 'id')) return; // Notifications do not complete RPCs.
    const waiter = pending.get(message.id);
    if (!waiter) { fail(new Error('Uncorrelated App Server response')); return; }
    pending.delete(message.id);
    // Do not persist arbitrary server error text or stderr, which can contain credentials.
    if (message.error) waiter.reject(new Error(`RPC ${waiter.method} failed: code=${message.error.code}`));
    else waiter.resolve(message.result);
  });
  return {
    async call(method, params) {
      if (!METHODS.has(method)) throw new Error(`Method outside probe scope: ${method}`);
      if (fatal) throw fatal;
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          fail(new Error(`App Server timeout: ${method}`));
          child.kill();
        }, 15000);
        pending.set(id, {
          method,
          resolve: value => { clearTimeout(timer); resolve(value); },
          reject: error => { clearTimeout(timer); reject(error); },
        });
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      });
    },
    initialized() {
      if (fatal) throw fatal;
      child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    },
    async close() {
      if (closed) return;
      child.kill();
      let timer;
      try {
        await Promise.race([
          closePromise,
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('App Server shutdown timeout; retain probe directory')), 5000); }),
        ]);
      } finally { clearTimeout(timer); }
    },
  };
}
