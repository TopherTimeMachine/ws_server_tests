// WebSocket speed-test server (Node.js + ws). See ../README.md for the protocol.
import { WebSocketServer } from 'ws';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const PORT = Number(process.env.PORT || 8081);
const HIGH_WATER = 1 << 20; // pause generating when ws buffers more than 1 MiB
const BATCH = 256;

const wss = new WebSocketServer({ port: PORT, path: '/ws', perMessageDeflate: false });

const loopDelay = monitorEventLoopDelay({ resolution: 1 });
loopDelay.enable();

// ---- process stats (reply to @{"cmd":"stats"}) ----
const startedAt = Date.now();
const counters = { connections: 0, msgsIn: 0, msgsOut: 0 };
const MB = 1048576;

function osThreads() {
  if (process.platform === 'linux') {
    return readFile('/proc/self/status', 'utf8')
      .then((t) => Number(/Threads:\s+(\d+)/.exec(t)?.[1]) || null)
      .catch(() => null);
  }
  return new Promise((resolve) =>
    execFile('ps', ['-M', '-p', String(process.pid)], (err, out) =>
      resolve(err ? null : out.trim().split('\n').length - 1)
    )
  );
}

async function stats() {
  const m = process.memoryUsage();
  const cpu = process.cpuUsage();
  const extra = {
    heapTotalMB: m.heapTotal / MB,
    externalMB: m.external / MB,
    arrayBuffersMB: m.arrayBuffers / MB
  };
  extra.eventLoopDelayP99Ms = loopDelay.percentile(99) / 1e6;
  extra.eventLoopDelayMaxMs = loopDelay.max / 1e6;
  loopDelay.reset();
  return {
    evt: 'stats', server: 'node', pid: process.pid, uptimeS: (Date.now() - startedAt) / 1000,
    cpuCores: os.availableParallelism(), rssMB: m.rss / MB, heapMB: m.heapUsed / MB,
    threads: await osThreads(), processes: null, connections: counters.connections,
    msgsIn: counters.msgsIn, msgsOut: counters.msgsOut, cpuMs: (cpu.user + cpu.system) / 1000, extra
  };
}

function makePayload(size) {
  return 'x'.repeat(size);
}

function generate(ws, count, size) {
  const pad = makePayload(size);
  const start = process.hrtime.bigint();
  let i = 0;
  const pump = () => {
    if (ws.readyState !== ws.OPEN) return;
    let n = 0;
    while (i < count && n < BATCH) {
      if (ws.bufferedAmount > HIGH_WATER) return setTimeout(pump, 0);
      ws.send(i + '|' + pad, { binary: false });
      i++; n++; counters.msgsOut++;
    }
    if (i < count) return setImmediate(pump);
    const serverMs = Number(process.hrtime.bigint() - start) / 1e6;
    ws.send('@' + JSON.stringify({ evt: 'done', count, size, serverMs }));
  };
  pump();
}

wss.on('connection', (ws) => {
  let mode = 'echo';
  counters.connections++;
  ws.on('close', () => counters.connections--);
  ws.on('message', (data, isBinary) => {
    if (!isBinary && data[0] === 0x40 /* '@' */) {
      let cmd;
      try { cmd = JSON.parse(data.toString().slice(1)); } catch { return; }
      switch (cmd.cmd) {
        case 'info':
        case 'mode':
          if (cmd.cmd === 'mode' && (cmd.mode === 'echo' || cmd.mode === 'generate')) mode = cmd.mode;
          ws.send('@' + JSON.stringify({ evt: 'info', server: 'node', runtime: 'Node ' + process.version, mode }));
          break;
        case 'stats':
          stats().then((st) => ws.readyState === ws.OPEN && ws.send('@' + JSON.stringify(st)));
          break;
        case 'start':
          if (mode === 'generate') generate(ws, Math.max(0, cmd.count | 0), Math.max(0, cmd.size | 0));
          break;
      }
      return;
    }
    counters.msgsIn++;
    if (mode === 'echo') { ws.send(data, { binary: isBinary }); counters.msgsOut++; }
  });
});

console.log(`node server listening on ws://localhost:${PORT}/ws`);
