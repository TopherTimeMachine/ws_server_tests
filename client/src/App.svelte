<script>
  import { onMount } from 'svelte';
  import BenchWorker from './lib/bench.worker.js?worker';
  import { probe } from './lib/bench.js';
  import BarChart from './lib/BarChart.svelte';
  import Playground from './lib/Playground.svelte';

  const STORE = 'ws-speed-test-v1';
  const saved = (() => { try { return JSON.parse(localStorage.getItem(STORE)) ?? {}; } catch { return {}; } })();

  const defaults = [
    { id: 'node', name: 'Node.js', color: '#5fa04e', url: 'ws://localhost:8081/ws' },
    { id: 'rust', name: 'Rust', color: '#e0703a', url: 'ws://localhost:8082/ws' },
    { id: 'elixir', name: 'Elixir', color: '#8e5bd4', url: 'ws://localhost:8083/ws' },
    { id: 'bun', name: 'Bun', color: '#d9a441', url: 'ws://localhost:8084/ws' },
    { id: 'go', name: 'Go', color: '#00acd7', url: 'ws://localhost:8085/ws' },
    { id: 'cpp', name: 'C++', color: '#d6457f', url: 'ws://localhost:8086/ws' }
  ];

  let servers = $state(
    defaults.map((d) => ({ ...d, url: saved.urls?.[d.id] ?? d.url, enabled: true, status: 'unknown', runtime: '', stats: null }))
  );
  let cfg = $state({ mode: 'echo', count: 20000, size: 256, connections: 1, windowSize: 64, binary: false, warmup: true, ...saved.cfg });
  let results = $state(saved.results ?? []);
  let running = $state(false);
  let current = $state(null); // { id, done, total }
  let cancelled = false;
  let worker = null;

  $effect(() => {
    const data = { urls: Object.fromEntries(servers.map((s) => [s.id, s.url])), cfg: $state.snapshot(cfg), results: $state.snapshot(results).slice(0, 100) };
    try { localStorage.setItem(STORE, JSON.stringify(data)); } catch {}
  });

  async function refresh(s) {
    s.status = 'unknown';
    try {
      const info = await probe(s.url);
      s.status = 'online';
      s.runtime = info.runtime;
      s.stats = info.stats;
    } catch {
      s.status = 'offline';
      s.runtime = '';
      s.stats = null;
    }
  }
  const refreshAll = () => servers.forEach(refresh);
  onMount(refreshAll);

  function runOne(s) {
    return new Promise((resolve) => {
      worker?.terminate();
      worker = new BenchWorker();
      const id = crypto.randomUUID();
      current = { id: s.id, done: 0, total: cfg.count };
      const finish = (result) => { worker.terminate(); worker = null; current = null; resolve(result); };
      worker.onmessage = (ev) => {
        const m = ev.data;
        if (m.type === 'progress') current = { id: s.id, done: m.done, total: m.total };
        else if (m.type === 'result') finish({ ...m.result, ok: true });
        else finish({ ok: false, error: m.message });
      };
      worker.onerror = (e) => finish({ ok: false, error: e.message || 'worker error' });
      worker.postMessage({ id, url: s.url, cfg: $state.snapshot(cfg) });
    });
  }

  async function run(list) {
    if (running) return;
    running = true;
    cancelled = false;
    for (const s of list) {
      if (cancelled) break;
      const r = await runOne(s);
      if (cancelled) break;
      const entry = { ...r, server: s.id, at: Date.now(), mode: cfg.mode, count: cfg.count, size: cfg.size,
        connections: cfg.connections, windowSize: cfg.windowSize };
      results = [entry, ...results];
      refresh(s);
    }
    running = false;
  }
  function cancel() {
    cancelled = true;
    worker?.terminate();
    worker = null;
    current = null;
    running = false;
  }

  const byId = (id) => servers.find((s) => s.id === id);
  const latest = $derived(
    servers.map((s) => ({ s, r: results.find((r) => r.server === s.id && r.ok && r.mode === cfg.mode) }))
  );
  const items = (fn) => latest.map(({ s, r }) => ({ label: s.name, color: s.color, value: r ? fn(r) : null }));
  const idleLine = (st) =>
    st
      ? [
          st.rssMB != null && `${fmt(st.rssMB, 1)} MB RSS`,
          st.threads != null && `${st.threads} threads`,
          st.processes != null && `${fmt(st.processes)} procs`,
          `${st.connections} conn`
        ].filter(Boolean).join(' · ')
      : '';
  const fmt = (n, d = 0) => (n == null ? '—' : n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }));
</script>

<main>
  <h1>WebSocket Speed Test</h1>
  <p class="sub">Compare Node.js, Rust, Elixir, Bun, Go and C++ WebSocket servers: echo round-trips and server-generated streams.</p>

  <section class="card">
    <div class="row" style="justify-content:space-between; margin-bottom:12px">
      <h2 style="margin:0">Servers</h2>
      <button onclick={refreshAll}>Refresh status</button>
    </div>
    <div class="grid servers">
      {#each servers as s}
        <div class="server" style="--c:{s.color}">
          <div class="head">
            <span><span class="dot {s.status}"></span>{s.name}</span>
            <label class="inline"><input type="checkbox" bind:checked={s.enabled} /> include</label>
          </div>
          <input bind:value={s.url} onchange={() => refresh(s)} spellcheck="false" />
          <div class="runtime">{s.status === 'offline' ? 'offline: is the server running?' : s.runtime}</div>
          {#if s.stats}
            <div class="runtime">{idleLine(s.stats)}</div>
            <details>
              <summary class="runtime">all stats</summary>
              <div class="kv">
                {#each [['pid', s.stats.pid], ['uptime', fmt(s.stats.uptimeS) + ' s'], ['cores', s.stats.cpuCores], ['heap', s.stats.heapMB == null ? '—' : fmt(s.stats.heapMB, 1) + ' MB'], ['messages in', fmt(s.stats.msgsIn)], ['messages out', fmt(s.stats.msgsOut)], ...Object.entries(s.stats.extra ?? {}).map(([k, v]) => [k, typeof v === 'number' ? fmt(v, 2) : v])] as [k, v]}
                  <span>{k}</span><span>{v}</span>
                {/each}
              </div>
            </details>
          {/if}
        </div>
      {/each}
    </div>
  </section>

  <section class="card">
    <h2>Test configuration</h2>
    <div class="grid fields">
      <label>Mode
        <select bind:value={cfg.mode}>
          <option value="echo">Echo (client sends, server repeats)</option>
          <option value="generate">Generate (server produces)</option>
        </select>
      </label>
      <label>Messages <input type="number" min="1" step="1000" bind:value={cfg.count} /></label>
      <label>Payload size (bytes) <input type="number" min="0" bind:value={cfg.size} /></label>
      <label>Connections <input type="number" min="1" max="64" bind:value={cfg.connections} /></label>
      {#if cfg.mode === 'echo'}
        <label>In-flight window <input type="number" min="1" bind:value={cfg.windowSize} /></label>
        <label class="inline"><input type="checkbox" bind:checked={cfg.binary} /> Binary frames</label>
        <label class="inline"><input type="checkbox" bind:checked={cfg.warmup} /> Warm-up</label>
      {/if}
    </div>
    <div class="row" style="margin-top:14px">
      <button class="primary" disabled={running || !servers.some((s) => s.enabled)} onclick={() => run(servers.filter((s) => s.enabled))}>
        Run all selected
      </button>
      {#each servers as s}
        <button disabled={running} onclick={() => run([s])}>Run {s.name}</button>
      {/each}
      {#if running}<button onclick={cancel}>Cancel</button>{/if}
    </div>
    {#if current}
      <div class="muted" style="margin-top:10px">Running {byId(current.id).name}… {fmt(current.done)} / {fmt(current.total)}</div>
      <div class="progress"><div style="width:{(current.done / current.total) * 100}%"></div></div>
    {/if}
    <p class="muted" style="margin:12px 0 0">
      Echo window = how many messages are in flight at once (1 measures pure round-trip latency; larger values measure throughput).
      The browser is the load generator, so very fast servers may be limited by the client.
    </p>
  </section>

  <section class="card">
    <div class="row" style="justify-content:space-between; margin-bottom:12px">
      <h2 style="margin:0">Comparison <span class="muted">· latest {cfg.mode} run per server</span></h2>
      <button onclick={() => (results = [])} disabled={!results.length}>Clear history</button>
    </div>
    {#if latest.some((x) => x.r)}
      <div class="charts">
        <BarChart title="Throughput" unit="messages/s" items={items((r) => r.msgsPerSec)} />
        <BarChart title="Data rate" unit="MB/s" digits={1} items={items((r) => r.mbPerSec)} />
        {#if cfg.mode === 'echo'}
          <BarChart title="Median latency" unit="ms" digits={2} lowerIsBetter items={items((r) => r.lat.p50)} />
          <BarChart title="p99 latency" unit="ms" digits={2} lowerIsBetter items={items((r) => r.lat.p99)} />
        {:else}
          <BarChart title="Server generate time" unit="ms" lowerIsBetter items={items((r) => r.serverMs)} />
          <BarChart title="Time to first message" unit="ms" digits={1} lowerIsBetter items={items((r) => r.ttfbMs)} />
        {/if}
      </div>
      <div class="charts">
        <BarChart title="Peak memory (RSS)" unit="MB" digits={1} lowerIsBetter items={items((r) => r.stats?.peakRssMB)} />
        <BarChart title="CPU used during test" unit="% of one core" lowerIsBetter items={items((r) => r.stats?.cpuPct)} />
        <BarChart title="CPU time per 1k messages" unit="ms" digits={2} lowerIsBetter items={items((r) => (r.stats ? r.stats.cpuMs / (r.count / 1000) : null))} />
        <BarChart title="OS threads (peak)" unit="threads" lowerIsBetter items={items((r) => r.stats?.peakThreads)} />
        {#if latest.some((x) => x.r?.stats?.peakProcesses)}
          <BarChart title="Erlang processes (peak)" unit="processes" lowerIsBetter items={items((r) => r.stats?.peakProcesses)} />
        {/if}
      </div>
    {:else}
      <p class="muted">No {cfg.mode} results yet. Start the servers and run a test.</p>
    {/if}

    {#if results.length}
      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th>Server</th><th>Mode</th><th>Msgs</th><th>Size</th><th>Conns</th><th>Window</th>
              <th>Msgs/s</th><th>MB/s</th><th>Total ms</th><th>CPU %</th><th>Peak RSS MB</th><th>Threads</th><th>avg</th><th>p50</th><th>p95</th><th>p99</th><th>max</th><th>Server ms</th>
            </tr>
          </thead>
          <tbody>
            {#each results.slice(0, 30) as r}
              {@const s = byId(r.server)}
              <tr>
                <td><span class="dot" style="background:{s.color}"></span>{s.name}</td>
                {#if r.ok}
                  <td>{r.mode}{r.binary ? ' (bin)' : ''}</td><td>{fmt(r.count)}</td><td>{fmt(r.size)}</td><td>{r.connections}</td>
                  <td>{r.mode === 'echo' ? r.windowSize : '—'}</td>
                  <td><strong>{fmt(r.msgsPerSec)}</strong></td><td>{fmt(r.mbPerSec, 1)}</td><td>{fmt(r.totalMs)}</td>
                  <td>{fmt(r.stats?.cpuPct)}</td><td>{fmt(r.stats?.peakRssMB, 1)}</td><td>{fmt(r.stats?.peakThreads)}</td>
                  <td>{fmt(r.lat?.avg, 2)}</td><td>{fmt(r.lat?.p50, 2)}</td><td>{fmt(r.lat?.p95, 2)}</td>
                  <td>{fmt(r.lat?.p99, 2)}</td><td>{fmt(r.lat?.max, 2)}</td><td>{fmt(r.serverMs)}</td>
                {:else}
                  <td>{r.mode}</td><td colspan="16" class="err" style="text-align:left">{r.error}</td>
                {/if}
              </tr>
              {#if r.ok && r.outOfOrder}
                <tr><td colspan="18" class="err" style="text-align:left">⚠ {r.outOfOrder} messages arrived out of order or were dropped</td></tr>
              {/if}
            {/each}
          </tbody>
        </table>
      </div>
      <p class="muted" style="margin:8px 0 0">Latencies in ms. Showing the 30 most recent runs.</p>
    {/if}
  </section>

  <Playground {servers} />
</main>
