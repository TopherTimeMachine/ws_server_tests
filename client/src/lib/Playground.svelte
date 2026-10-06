<script>
  let { servers } = $props();

  let serverId = $state('node');
  let ws = $state(null);
  let mode = $state('echo');
  let text = $state('hello from the browser');
  let genCount = $state(1000);
  let genSize = $state(64);
  let lines = $state([]);
  let received = $state(0);
  let logEl;

  const url = $derived(servers.find((s) => s.id === serverId)?.url);

  function log(line) {
    lines = [...lines.slice(-199), `${new Date().toLocaleTimeString()}  ${line}`];
    queueMicrotask(() => logEl && (logEl.scrollTop = logEl.scrollHeight));
  }

  function connect() {
    const sock = new WebSocket(url);
    sock.onopen = () => { ws = sock; received = 0; log(`connected to ${url}`); setMode(mode); };
    sock.onclose = () => { ws = null; log('disconnected'); };
    sock.onerror = () => log('error: connection failed');
    sock.onmessage = (ev) => {
      received++;
      const d = ev.data;
      const s = typeof d === 'string' ? d : `<binary ${d.size ?? d.byteLength} bytes>`;
      // Don't flood the log in generate mode: show the first few and every control message.
      if (s[0] === '@' || received <= 20 || received % 1000 === 0) log(`← ${s.length > 160 && s[0] !== '@' ? s.slice(0, 160) + '…' : s}`);
    };
  }
  const disconnect = () => ws?.close();
  function setMode(m) {
    mode = m;
    ws?.send('@' + JSON.stringify({ cmd: 'mode', mode: m }));
  }
  function send() {
    if (!ws || !text) return;
    ws.send(text);
    log(`→ ${text}`);
  }
  function start() {
    ws?.send('@' + JSON.stringify({ cmd: 'start', count: genCount, size: genSize }));
    log(`→ start generate count=${genCount} size=${genSize}`);
  }
</script>

<section class="card">
  <h2>Playground</h2>
  <div class="row" style="margin-bottom:10px">
    <select bind:value={serverId} disabled={!!ws} style="width:auto">
      {#each servers as s}<option value={s.id}>{s.name}</option>{/each}
    </select>
    {#if ws}<button onclick={disconnect}>Disconnect</button>{:else}<button class="primary" onclick={connect}>Connect</button>{/if}
    <div class="tabs">
      <button class:on={mode === 'echo'} onclick={() => setMode('echo')}>Echo</button>
      <button class:on={mode === 'generate'} onclick={() => setMode('generate')}>Generate</button>
    </div>
    <button onclick={() => ws?.send('@{"cmd":"stats"}')} disabled={!ws}>Stats</button>
    <span class="muted">{received} received</span>
  </div>
  {#if mode === 'echo'}
    <div class="row" style="margin-bottom:10px">
      <input bind:value={text} onkeydown={(e) => e.key === 'Enter' && send()} style="flex:1" disabled={!ws} />
      <button onclick={send} disabled={!ws}>Send</button>
    </div>
  {:else}
    <div class="row" style="margin-bottom:10px">
      <label class="inline">count <input type="number" min="1" bind:value={genCount} style="width:110px" /></label>
      <label class="inline">size <input type="number" min="0" bind:value={genSize} style="width:90px" /></label>
      <button onclick={start} disabled={!ws}>Start generating</button>
    </div>
  {/if}
  <div class="log" bind:this={logEl}>{lines.join('\n')}</div>
</section>
