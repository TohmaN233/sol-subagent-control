import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// Separate from the metadata-only client so that adding turns does not expand its authority.
export function createTurnProbeClient(binary, { home, cwd, live = false, onToolCall }) {
  const methods = new Set(['initialize', 'skills/list', 'skills/config/write', 'thread/start', 'turn/start', 'turn/interrupt']);
  if (live) for (const method of ['account/read', 'account/login/start', 'account/login/cancel']) methods.add(method);
  const child = spawn(binary, ['app-server', '--stdio'], {
    cwd, env: { ...process.env, CODEX_HOME: home }, windowsHide: true, shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  const events = [];
  const eventWaiters = new Set();
  let nextId = 1;
  let fatal;
  let closed = false;
  let stderrBytes = 0;
  const closedPromise = new Promise(resolve => child.once('close', () => { closed = true; resolve(); }));
  function fail(error) {
    fatal ??= error;
    for (const waiter of pending.values()) waiter.reject(fatal);
    pending.clear();
    for (const waiter of eventWaiters) waiter.reject(fatal);
    eventWaiters.clear();
  }
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.stdout.on('error', fail);
  child.stderr.on('data', data => { stderrBytes += data.length; });
  child.on('exit', (code, signal) => fail(new Error(`App Server exited: code=${code}, signal=${signal}, stderr_bytes=${stderrBytes}`)));
  function write(message) { child.stdin.write(JSON.stringify(message) + '\n'); }
  createInterface({ input: child.stdout }).on('line', line => {
    try {
      const message = JSON.parse(line);
      if (message.method) {
        if (Object.hasOwn(message, 'id')) {
          if (message.method !== 'item/tool/call' || !onToolCall) throw new Error('Unexpected interactive App Server request');
          const result = onToolCall(message.params);
          write({ id: message.id, result });
          return;
        }
        if (events.length >= 2000) throw new Error('Probe event limit exceeded');
        events.push(message);
        for (const waiter of [...eventWaiters]) if (waiter.matches(message)) waiter.resolve(message);
        return;
      }
      const waiter = pending.get(message.id);
      if (!waiter) throw new Error('Uncorrelated App Server response');
      pending.delete(message.id);
      // Server error bodies and stderr may contain credential URLs. Record metadata only.
      if (message.error) waiter.reject(new Error(`RPC ${waiter.method} failed: code=${message.error.code}`));
      else waiter.resolve(message.result);
    } catch (error) { fail(error); child.kill(); }
  });
  return {
    events,
    call(method, params) {
      if (!methods.has(method)) throw new Error(`Method outside probe scope: ${method}`);
      if (fatal) throw fatal;
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { fail(new Error(`RPC deadline: ${method}`)); child.kill(); }, 20000);
        pending.set(id, {
          method,
          resolve: value => { clearTimeout(timer); resolve(value); },
          reject: error => { clearTimeout(timer); reject(error); },
        });
        write({ id, method, params });
      });
    },
    initialized() { if (fatal) throw fatal; write({ method: 'initialized' }); },
    waitFor(matches, { after = 0, timeout = 60000 } = {}) {
      if (fatal) return Promise.reject(fatal);
      const found = events.slice(after).find(matches);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => waiter.reject(new Error('Probe event deadline')), timeout);
        const waiter = {
          matches,
          resolve: value => { clearTimeout(timer); eventWaiters.delete(waiter); resolve(value); },
          reject: error => { clearTimeout(timer); eventWaiters.delete(waiter); reject(error); },
        };
        eventWaiters.add(waiter);
      });
    },
    async close() {
      if (closed) return;
      child.kill();
      let timer;
      try {
        await Promise.race([closedPromise, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('App Server shutdown deadline; retain profile')), 5000);
        })]);
      } finally { clearTimeout(timer); }
    },
  };
}
