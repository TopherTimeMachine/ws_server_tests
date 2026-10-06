// Benchmark engine. Runs inside a Web Worker (see bench.worker.js) but has no worker-specific code.
// Protocol: text frames beginning with "@" are control messages (JSON after the "@").

const STALL_MS = 15000;

export function connect(url, mode, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    const timer = setTimeout(() => { ws.close(); reject(new Error('connect timeout')); }, timeoutMs);
    ws.onerror = () => { clearTimeout(timer); reject(new Error('connection failed')); };
    ws.onclose = () => { clearTimeout(timer); reject(new Error('closed during setup')); };
    ws.onopen = () => ws.send('@' + JSON.stringify({ cmd: 'mode', mode }));
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string' || ev.data[0] !== '@') return;
      const msg = JSON.parse(ev.data.slice(1));
      if (msg.evt !== 'info') return;
      clearTimeout(timer);
      ws.onerror = ws.onclose = ws.onmessage = null;
      ws.info = msg;
      resolve(ws);
    };
  });
}


export function getStats(ws, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('stats timeout')), timeoutMs);
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string' || ev.data[0] !== '@') return;
      const msg = JSON.parse(ev.data.slice(1));
      if (msg.evt !== 'stats') return;
      clearTimeout(timer);
      resolve(msg);
    };
    ws.send('@' + JSON.stringify({ cmd: 'stats' }));
  });
}

/** Polls server stats on a dedicated connection while a test runs. */
function startSampler(ws, intervalMs = 400) {
  const samples = [];
  let stopped = false;
  let wake = null;
  const loop = (async () => {
    while (!stopped) {
      try { samples.push(await getStats(ws)); } catch { break; }
      await new Promise((r) => { wake = r; setTimeout(r, intervalMs); });
    }
  })();
  return async () => { stopped = true; wake?.(); await loop; return samples; };
}

function summarize(before, after, samples, wallMs) {
  const all = [before, ...samples, after];
  const peak = (k) => {
    const vals = all.map((s) => s[k]).filter((v) => typeof v === 'number');
    return vals.length ? Math.max(...vals) : null;
  };
  return {
    pid: after.pid,
    cpuCores: after.cpuCores,
    uptimeS: after.uptimeS,
    rssBeforeMB: before.rssMB,
    peakRssMB: peak('rssMB'),
    peakHeapMB: peak('heapMB'),
    peakThreads: peak('threads'),
    peakProcesses: peak('processes'),
    peakConnections: Math.max(0, (peak('connections') ?? 1) - 1), // minus the stats connection
    cpuMs: after.cpuMs - before.cpuMs,
    cpuPct: ((after.cpuMs - before.cpuMs) / wallMs) * 100, // 100% = one core fully busy
    msgsIn: after.msgsIn - before.msgsIn,
    msgsOut: after.msgsOut - before.msgsOut,
    extra: after.extra
  };
}

function stallGuard(ws, reject) {
  let timer;
  const bump = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { ws.close(); reject(new Error(`stalled: no data for ${STALL_MS / 1000}s`)); }, STALL_MS);
  };
  bump();
  ws.onclose = () => { clearTimeout(timer); reject(new Error('connection closed mid-test')); };
  ws.onerror = () => { clearTimeout(timer); reject(new Error('socket error')); };
  return { bump, stop: () => { clearTimeout(timer); ws.onclose = ws.onerror = null; } };
}

function echoConn(ws, { count, size, windowSize, binary }, onTick) {
  return new Promise((resolve, reject) => {
    const guard = stallGuard(ws, reject);
    const lat = new Float64Array(count);
    const sentAt = new Float64Array(count);
    const pad = 'x'.repeat(size);
    const buf = binary ? new Uint8Array(size + 4) : null;
    const view = binary ? new DataView(buf.buffer) : null;
    let sent = 0, recv = 0;

    const sendNext = () => {
      sentAt[sent] = performance.now();
      if (binary) { view.setUint32(0, sent); ws.send(buf); } else { ws.send(sent + '|' + pad); }
      sent++;
    };

    ws.onmessage = (ev) => {
      const now = performance.now();
      const seq = binary ? new DataView(ev.data).getUint32(0) : parseInt(ev.data, 10);
      if (!(seq >= 0 && seq < count)) return;
      lat[recv++] = now - sentAt[seq];
      guard.bump();
      onTick(1);
      if (sent < count) sendNext();
      if (recv === count) { guard.stop(); resolve({ lat, bytes: count * size }); }
    };

    if (count === 0) { guard.stop(); return resolve({ lat, bytes: 0 }); }
    const initial = Math.min(windowSize, count);
    for (let i = 0; i < initial; i++) sendNext();
  });
}

function generateConn(ws, { count, size }, onTick) {
  return new Promise((resolve, reject) => {
    const guard = stallGuard(ws, reject);
    let recv = 0, bytes = 0, outOfOrder = 0, firstAt = 0, serverMs = 0, pending = 0;

    ws.onmessage = (ev) => {
      const d = ev.data;
      if (typeof d !== 'string') return;
      if (d.charCodeAt(0) === 64 /* @ */) {
        const msg = JSON.parse(d.slice(1));
        if (msg.evt === 'done') {
          guard.stop();
          onTick(pending);
          serverMs = msg.serverMs;
          resolve({ recv, bytes, outOfOrder, firstAt, serverMs });
        }
        return;
      }
      if (recv === 0) firstAt = performance.now();
      if (parseInt(d, 10) !== recv) outOfOrder++;
      recv++;
      bytes += d.length;
      if (++pending >= 512) { guard.bump(); onTick(pending); pending = 0; }
    };

    ws.send('@' + JSON.stringify({ cmd: 'start', count, size }));
  });
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function split(total, parts) {
  const base = Math.floor(total / parts);
  return Array.from({ length: parts }, (_, i) => base + (i < total % parts ? 1 : 0));
}

/**
 * cfg: { mode: 'echo'|'generate', count, size, connections, windowSize, binary, warmup }
 * onProgress(done, total)
 */
export async function runBenchmark(url, cfg, onProgress = () => {}) {
  const { mode, count, size, connections, windowSize, binary } = cfg;
  const result = { url, mode, count, size, connections, windowSize, binary: mode === 'echo' && binary };

  if (mode === 'echo' && cfg.warmup) {
    const warm = await Promise.all(Array.from({ length: Math.min(connections, 2) }, () => connect(url, mode)));
    await Promise.all(warm.map((ws) => echoConn(ws, { count: 300, size, windowSize: Math.min(windowSize, 32), binary }, () => {})));
    warm.forEach((ws) => ws.close());
  }

  const sockets = await Promise.all(Array.from({ length: connections }, () => connect(url, mode)));
  result.runtime = sockets[0].info.runtime;
  const counts = split(count, connections);
  let done = 0;
  let lastReport = 0;
  const tick = (n) => {
    done += n;
    const now = performance.now();
    if (now - lastReport > 100 || done >= count) { lastReport = now; onProgress(done, count); }
  };

  let statsWs = null, stopSampler = null, before = null, tBefore = 0;
  try {
    statsWs = await connect(url, 'echo');
    before = await getStats(statsWs);
    tBefore = performance.now();
    stopSampler = startSampler(statsWs);
  } catch { statsWs = null; }

  const t0 = performance.now();
  try {
    if (mode === 'echo') {
      const parts = await Promise.all(
        sockets.map((ws, i) => echoConn(ws, { count: counts[i], size, windowSize, binary }, tick))
      );
      const totalMs = performance.now() - t0;
      const all = new Float64Array(count);
      let off = 0;
      for (const p of parts) { all.set(p.lat, off); off += p.lat.length; }
      all.sort();
      let sum = 0;
      for (let i = 0; i < all.length; i++) sum += all[i];
      Object.assign(result, {
        totalMs,
        recv: count,
        lat: { avg: sum / count, p50: percentile(all, 50), p95: percentile(all, 95), p99: percentile(all, 99), max: all[all.length - 1] ?? 0 },
        bytes: parts.reduce((a, p) => a + p.bytes, 0)
      });
    } else {
      const parts = await Promise.all(sockets.map((ws, i) => generateConn(ws, { count: counts[i], size }, tick)));
      const totalMs = performance.now() - t0;
      Object.assign(result, {
        totalMs,
        recv: parts.reduce((a, p) => a + p.recv, 0),
        bytes: parts.reduce((a, p) => a + p.bytes, 0),
        outOfOrder: parts.reduce((a, p) => a + p.outOfOrder, 0),
        serverMs: Math.max(...parts.map((p) => p.serverMs)),
        ttfbMs: Math.min(...parts.map((p) => p.firstAt)) - t0,
        lat: null
      });
    }
  } finally {
    if (statsWs) {
      try {
        const samples = await stopSampler();
        const after = await getStats(statsWs);
        result.stats = summarize(before, after, samples, performance.now() - tBefore);
      } catch { result.stats = null; }
      statsWs.onmessage = statsWs.onclose = statsWs.onerror = null;
      statsWs.close();
    }
    sockets.forEach((ws) => { ws.onmessage = ws.onclose = ws.onerror = null; ws.close(); });
  }
  onProgress(count, count);
  result.msgsPerSec = result.recv / (result.totalMs / 1000);
  result.mbPerSec = result.bytes / 1048576 / (result.totalMs / 1000);
  return result;
}

/** Quick connectivity + identity check used for the status badges. */
export async function probe(url) {
  const ws = await connect(url, 'echo', 2000);
  const info = ws.info;
  let stats = null;
  try { stats = await getStats(ws, 2000); } catch {}
  ws.close();
  return { ...info, stats };
}
