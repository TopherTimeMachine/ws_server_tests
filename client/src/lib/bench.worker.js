import { runBenchmark } from './bench.js';

self.onmessage = async (ev) => {
  const { id, url, cfg } = ev.data;
  try {
    const result = await runBenchmark(url, cfg, (done, total) => self.postMessage({ id, type: 'progress', done, total }));
    self.postMessage({ id, type: 'result', result });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err.message || String(err) });
  }
};
