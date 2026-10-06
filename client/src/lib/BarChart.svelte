<script>
  let { title, unit = '', items, lowerIsBetter = false, digits = 0 } = $props();

  const valid = $derived(items.filter((i) => i.value != null && isFinite(i.value)));
  const max = $derived(Math.max(...valid.map((i) => i.value), 0.000001));
  const best = $derived(
    valid.length > 1
      ? (lowerIsBetter ? Math.min : Math.max)(...valid.map((i) => i.value))
      : null
  );
  const fmt = (v) => v.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
</script>

<div class="chart">
  <h3>{title} <small>{unit}{lowerIsBetter ? ' · lower is better' : ' · higher is better'}</small></h3>
  {#each items as item}
    {@const has = item.value != null && isFinite(item.value)}
    <div class="bar" class:best={has && item.value === best}>
      <span>{item.label}</span>
      <div class="track">
        {#if has}<div class="fill" style="width:{(item.value / max) * 100}%; background:{item.color}"></div>{/if}
      </div>
      <span class="val">{has ? fmt(item.value) : '—'}</span>
    </div>
  {/each}
</div>
