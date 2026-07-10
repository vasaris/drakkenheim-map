// Ф3.3-Т: замер частоты кадров композитора через сырой CDP-трейсинг —
// НЕ rAF-счётчик (тот меряет скрипт-луп, не то, что реально долетело до экрана).
//
// Категория 'disabled-by-default-devtools.timeline.frame' даёт три инстант-события
// с общим frameSeqId на кадр: BeginFrame (запрос кадра у рендерера), DrawFrame
// (кадр реально отрисован и закоммичен), DroppedFrame (Chrome сам решил, что кадр
// пропущен — не наша эвристика, штатное решение композитора). Проверено вручную
// на этой же машине/сборке chromium (scratchpad diag-trace.js): все три события
// присутствуют, ts — микросекунды, шаг BeginFrame ~16.6ms на 60Hz дисплее.

/**
 * @param {import('@playwright/test').CDPSession} client
 * @param {() => Promise<void>} scenario — что делать, пока трейс пишется
 * @returns {Promise<{avgMs:number, p95Ms:number, droppedPct:number, frames:number, dropped:number}>}
 */
async function traceFrameStats(client, scenario) {
  const events = [];
  const onData = (e) => events.push(...e.value);
  client.on('Tracing.dataCollected', onData);
  const complete = new Promise((resolve) => client.once('Tracing.tracingComplete', resolve));

  await client.send('Tracing.start', {
    categories: 'disabled-by-default-devtools.timeline.frame',
    transferMode: 'ReportEvents',
  });

  try {
    await scenario();
  } finally {
    await client.send('Tracing.end');
    await complete;
    client.off('Tracing.dataCollected', onData);
  }

  return summarize(events);
}

function summarize(events) {
  const begins = events.filter((e) => e.name === 'BeginFrame').sort((a, b) => a.ts - b.ts);
  const dropped = events.filter((e) => e.name === 'DroppedFrame');

  if (begins.length < 2) {
    return { avgMs: 0, p95Ms: 0, droppedPct: 0, frames: begins.length, dropped: dropped.length };
  }

  const deltasMs = [];
  for (let i = 1; i < begins.length; i++) {
    deltasMs.push((begins[i].ts - begins[i - 1].ts) / 1000);
  }
  deltasMs.sort((a, b) => a - b);

  const avgMs = deltasMs.reduce((s, v) => s + v, 0) / deltasMs.length;
  const p95Idx = Math.min(deltasMs.length - 1, Math.floor(deltasMs.length * 0.95));
  const p95Ms = deltasMs[p95Idx];
  const droppedPct = (dropped.length / begins.length) * 100;

  return {
    avgMs: +avgMs.toFixed(2),
    p95Ms: +p95Ms.toFixed(2),
    droppedPct: +droppedPct.toFixed(2),
    frames: begins.length,
    dropped: dropped.length,
  };
}

module.exports = { traceFrameStats };
