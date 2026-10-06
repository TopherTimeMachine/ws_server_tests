// WebSocket speed-test server (Bun.serve). See ../README.md for the protocol.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
const PORT = Number(process.env.PORT || 8084);
const BATCH = 1024;


// ---- process stats (reply to @{"cmd":"stats"}) ----
const startedAt = Date.now();
const counters = { connections: 0, msgsIn: 0, msgsOut: 0 };
const MB = 1048576;

function osThreads(): Promise<number | null> {
  if (process.platform === 'linux') {
    return readFile('/proc/self/status', 'utf8')
      .then((t) => Number(/Threads:\s+(\d+)/.exec(t)?.[1]) || null)
      .catch(() => null);
  }
  return new Promise((resolve: (n: number | null) => void) =>
    execFile('ps', ['-M', '-p', String(process.pid)], (err, out) =>
      resolve(err ? null : out.trim().split('\n').length - 1)
    )
  );
}

async function stats() {
  const m = process.memoryUsage();
  const cpu = process.cpuUsage();
  const extra: Record<string, number | string> = {
    heapTotalMB: m.heapTotal / MB,
    externalMB: m.external / MB,
    arrayBuffersMB: m.arrayBuffers / MB
  };
  extra.bunVersion = Bun.version;
  return {
    evt: 'stats', server: 'bun', pid: process.pid, uptimeS: (Date.now() - startedAt) / 1000,
    cpuCores: os.availableParallelism(), rssMB: m.rss / MB, heapMB: m.heapUsed / MB,
    threads: await osThreads(), processes: null, connections: counters.connections,
    msgsIn: counters.msgsIn, msgsOut: counters.msgsOut, cpuMs: (cpu.user + cpu.system) / 1000, extra
  };
}

type Gen = { i: number; count: number; size: number; pad: string; start: number };
type Data = { mode: 'echo' | 'generate'; gen?: Gen };
type Sock = import('bun').ServerWebSocket<Data>;

// Sends frames until done, or until Bun reports backpressure (-1); drain() then resumes.
function pump(ws: Sock) {
  const g = ws.data.gen;
  if (!g) return;
  let n = 0;
  while (g.i < g.count && n < BATCH) {
    const r = ws.send(g.i + '|' + g.pad);
    g.i++; n++; counters.msgsOut++;
    if (r === -1) return; // backpressure: wait for drain
    if (r === 0) { ws.data.gen = undefined; return; } // connection dropped
  }
  if (g.i < g.count) return void setImmediate(() => pump(ws));
  const serverMs = performance.now() - g.start;
  ws.data.gen = undefined;
  ws.send('@' + JSON.stringify({ evt: 'done', count: g.count, size: g.size, serverMs }));
}

Bun.serve<Data>({
  port: PORT,
  fetch(req, server) {
    if (new URL(req.url).pathname === '/ws' && server.upgrade(req, { data: { mode: 'echo' } })) return;
    return new Response('not found', { status: 404 });
  },
  websocket: {
    perMessageDeflate: false,
    open() { counters.connections++; },
    close() { counters.connections--; },
    message(ws, msg) {
      if (typeof msg === 'string' && msg.charCodeAt(0) === 64 /* @ */) {
        let cmd: any;
        try { cmd = JSON.parse(msg.slice(1)); } catch { return; }
        if (cmd.cmd === 'info' || cmd.cmd === 'mode') {
          if (cmd.cmd === 'mode' && (cmd.mode === 'echo' || cmd.mode === 'generate')) ws.data.mode = cmd.mode;
          ws.send('@' + JSON.stringify({ evt: 'info', server: 'bun', runtime: 'Bun ' + Bun.version, mode: ws.data.mode }));
        } else if (cmd.cmd === 'stats') {
          stats().then((st) => ws.send('@' + JSON.stringify(st)));
        } else if (cmd.cmd === 'start' && ws.data.mode === 'generate') {
          const size = Math.max(0, cmd.size | 0);
          ws.data.gen = { i: 0, count: Math.max(0, cmd.count | 0), size, pad: 'x'.repeat(size), start: performance.now() };
          pump(ws);
        }
        return;
      }
      counters.msgsIn++;
      if (ws.data.mode === 'echo') { ws.send(msg); counters.msgsOut++; }
    },
    drain(ws) { pump(ws); }
  }
});

console.log(`bun server listening on ws://localhost:${PORT}/ws`);
