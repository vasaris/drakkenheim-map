// Ф3.3-Т: замер FPS/дропа кадров прод (:8032, Leaflet fog-engine) vs стенд (:8033,
// dk-spike — вердикт B, зафиксирован, см. js/fog-engine.js шапку). Только локально,
// headed (нужно реальное окно — throttling occluded/background-таймеров иначе искажает
// картину), помечено @perf в названиях тестов. Не входит в обычный `npm test`.
//
// Методика — сырой CDP-трейсинг композитора (tests/lib/cdp-frames.js), НЕ rAF-счётчик:
// rAF меряет скрипт-луп страницы, а не то, что реально дошло до экрана/было дропнуто
// композитором. Сценарии намеренно НЕ используют встроенный демо-HUD (?fps=1&auto=1) —
// тот на стенде ещё и прогоняет свою матрицу grain/blur конфигураций через
// sessionStorage+location.replace, что нам не нужно и мешало бы трейсингу.
//
// Ассерт ОТНОСИТЕЛЬНЫЙ (без абсолютных порогов): прод не хуже стенда более чем на 25%
// по p95 frame time и по доле дропнутых кадров — сравниваются только как отношение
// прод/стенд, никаких зашитых миллисекунд/процентов.

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { traceFrameStats } = require('./lib/cdp-frames');

const HOP_POINTS_NORM = [
  [[0.5, 0.5], 7],
  [[0.1, 0.1], 2],
  [[0.9, 0.9], 7],
  [[0.5, 0.5], 3],
];

const TARGETS = [
  {
    key: 'prod',
    label: 'прод :8032 (Ф3.3 fog-engine, tiles_v3 квадратный русский мастер)',
    url: 'http://localhost:8032/?engine=leaflet',
    hazezoneSelector: '#map svg .leaf-hazezone',
    ready: (page) => page.waitForFunction(() => !!(
      window.DKMapEngine && window.DKMapEngine.map
      && document.querySelector('#map svg .leaf-hazezone')
    )),
    normOfPoint: (page, px, py) => page.evaluate(({ px, py }) => {
      const DK = window.DKMapEngine;
      return { nx: px / DK.IMG_W, ny: py / DK.IMG_H };
    }, { px, py }),
    setViewNorm: (page, nx, ny, zoom) => page.evaluate(({ nx, ny, zoom }) => {
      const DK = window.DKMapEngine;
      DK.map.setView(DK.normToLatLng(nx, ny), zoom, { animate: false });
    }, { nx, ny, zoom }),
    runHop: (page, points, runMs) => page.evaluate(({ points, runMs }) => new Promise((resolve) => {
      const DK = window.DKMapEngine;
      const legs = points.map(([[nx, ny], z]) => [DK.normToLatLng(nx, ny), z]);
      let pi = 0;
      const t0 = performance.now();
      (function hop() {
        if (performance.now() - t0 >= runMs) return resolve();
        const [ll, z] = legs[pi % legs.length];
        pi++;
        // setTimeout, а не прямой вызов hop() из moveend: если цель совпадает с текущим
        // видом, Leaflet шлёт moveend СИНХРОННО внутри flyTo — прямая рекурсия уронит
        // стек за десятки мс (поймано смоук-тестом на коротких duration).
        DK.map.once('moveend', () => setTimeout(hop, 0));
        DK.map.flyTo(ll, z, { duration: 2.5 });
      })();
    }), { points, runMs }),
  },
  {
    key: 'stand',
    label: 'стенд :8033 (dk-spike, вердикт B: grain=0, blur/anim по умолчанию ON)',
    // grain=0 обязателен: вердикт B = без grain (см. js/fog-engine.js шапку — прод
    // feTurbulence не заводит вовсе). Без этого параметра dk-spike грузит grain ON
    // по умолчанию — не тот эталон, сравнение было бы нечестным для прод.
    url: 'http://localhost:8033/?grain=0',
    hazezoneSelector: '.hazezone',
    // dk-spike — не-модульный классический скрипт: map/normToLatLng объявлены
    // top-level const/function, не свисают на window, но видны напрямую как
    // идентификаторы из page.evaluate (та же реалм-область видимости, что и у
    // остальных классических <script> страницы) — проверено вручную (scratchpad diag.js).
    ready: (page) => page.waitForFunction(() => (
      typeof map !== 'undefined' && typeof normToLatLng === 'function'
      && !!document.querySelector('.hazezone')
    )),
    normOfPoint: (page, px, py) => page.evaluate(({ px, py }) => ({ nx: px / IMG_W, ny: py / IMG_H }), { px, py }),
    setViewNorm: (page, nx, ny, zoom) => page.evaluate(({ nx, ny, zoom }) => {
      map.setView(normToLatLng(nx, ny), zoom, { animate: false });
    }, { nx, ny, zoom }),
    runHop: (page, points, runMs) => page.evaluate(({ points, runMs }) => new Promise((resolve) => {
      const legs = points.map(([[nx, ny], z]) => [normToLatLng(nx, ny), z]);
      let pi = 0;
      const t0 = performance.now();
      (function hop() {
        if (performance.now() - t0 >= runMs) return resolve();
        const [ll, z] = legs[pi % legs.length];
        pi++;
        map.once('moveend', () => setTimeout(hop, 0));
        map.flyTo(ll, z, { duration: 2.5 });
      })();
    }), { points, runMs }),
  },
];

const SCENARIOS = [
  { key: 'static', label: 'статика 10s', durationMs: 10_000, run: (page) => page.waitForTimeout(10_000) },
  { key: 'breathe', label: 'breathe 20s', durationMs: 20_000, run: (page) => page.waitForTimeout(20_000) },
  {
    key: 'hop',
    label: 'авто-хоп 20s (как ?auto=1)',
    durationMs: 20_000,
    run: (page, target) => target.runHop(page, HOP_POINTS_NORM, 20_000),
  },
];

// Относительный ассерт без абсолютных порогов: прод/стенд <= 1.25.
// 0/0 (оба идеальны) — не регрессия. baseline=0, прод>0 — регрессия (обычная
// математика отношения: X/0 не занижаем никаким зашитым числом).
function withinRelativeBudget(prodVal, standVal, budget = 1.25) {
  if (prodVal === 0 && standVal === 0) return true;
  if (standVal === 0) return prodVal === 0;
  return prodVal / standVal <= budget;
}

function fmtRow(scenarioLabel, prod, stand) {
  return (
    `${scenarioLabel}\n` +
    `  прод : avg ${prod.avgMs}ms | p95 ${prod.p95Ms}ms | dropped ${prod.droppedPct}% (${prod.dropped}/${prod.frames})\n` +
    `  стенд: avg ${stand.avgMs}ms | p95 ${stand.p95Ms}ms | dropped ${stand.droppedPct}% (${stand.dropped}/${stand.frames})\n` +
    `  p95 прод/стенд = ${(prod.p95Ms / (stand.p95Ms || 1)).toFixed(2)}x`
  );
}

// top-level test.use — внутри describe Playwright требует новый воркер и падает
// на старте (см. историю правки: поймано первым прогоном).
test.use({
  headless: false,
  launchOptions: {
    args: [
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  },
});

test.describe('perf @perf: прод vs стенд (CDP frame tracing, headed)', () => {

  const summary = [];

  for (const scenario of SCENARIOS) {
    test(`${scenario.key}: ${scenario.label} @perf`, async ({ context }) => {
      test.setTimeout(scenario.durationMs * 2 + 60_000);

      const row = { scenario: scenario.label };
      for (const target of TARGETS) {
        const page = await context.newPage();
        await page.goto(target.url, { waitUntil: 'load' });
        await target.ready(page);
        await page.waitForTimeout(500); // тайлам/лэйауту осесть перед замером

        const client = await context.newCDPSession(page);
        row[target.key] = await traceFrameStats(client, () => scenario.run(page, target));
        await page.close();
      }
      summary.push(row);
      console.log('\n' + fmtRow(scenario.label, row.prod, row.stand));

      expect(
        withinRelativeBudget(row.prod.p95Ms, row.stand.p95Ms),
        `${scenario.label}: p95 прод ${row.prod.p95Ms}ms не должен превышать стенд×1.25 (стенд ${row.stand.p95Ms}ms)`
      ).toBe(true);
      expect(
        withinRelativeBudget(row.prod.droppedPct, row.stand.droppedPct),
        `${scenario.label}: dropped% прод ${row.prod.droppedPct}% не должен превышать стенд×1.25 (стенд ${row.stand.droppedPct}%)`
      ).toBe(true);
    });
  }

  test('итоговая таблица прод vs стенд @perf', async () => {
    test.skip(summary.length < SCENARIOS.length, 'предыдущие сценарии ещё не все отработали в этом воркере');
    const header = '| сценарий | прод avg/p95/dropped | стенд avg/p95/dropped | p95 прод/стенд |';
    const sep = '|---|---|---|---|';
    const lines = summary.map((r) => (
      `| ${r.scenario} ` +
      `| ${r.prod.avgMs}/${r.prod.p95Ms}/${r.prod.droppedPct}% ` +
      `| ${r.stand.avgMs}/${r.stand.p95Ms}/${r.stand.droppedPct}% ` +
      `| ${(r.prod.p95Ms / (r.stand.p95Ms || 1)).toFixed(2)}x |`
    ));
    console.log('\n=== ИТОГ: прод vs стенд ===\n' + [header, sep, ...lines].join('\n'));
  });

  test('edge-crop скриншоты (прод/стенд, один зум, край одного выреза) @perf', async ({ context }) => {
    test.setTimeout(60_000);
    const dir = path.join(__dirname, '..', 'artifacts');
    fs.mkdirSync(dir, { recursive: true });

    // Ф3.5в: NATIVE_Z прод выведен из MASTER_SIZE (map-engine.js) и меняется при
    // переключении мастера v3 на финальное разрешение — раньше был фиксированный
    // литерал 5, совпадавший с обоими движками случайно. Стенд (dk-spike) — заморожен,
    // свой z5 не меняется никогда; прод читает live свой собственный NATIVE_Z. Разные
    // зумы для разных таргетов не портят сравнение: цель скриншотов — визуальная сверка
    // фетеринга КАЖДОГО движка на СВОЁМ полном разрешении тайлов, не попиксельный diff.
    for (const target of TARGETS) {
      const page = await context.newPage();
      await page.setViewportSize({ width: 1000, height: 800 });
      await page.goto(target.url, { waitUntil: 'load' });
      await target.ready(page);
      const zoom = target.key === 'prod'
        ? await page.evaluate(() => window.DKMapEngine.NATIVE_Z)
        : 5; // стенд dk-spike — заморожен, свой NATIVE_Z всегда 5

      // Внутренняя точка, не край карты: перебираем КАЖДОЕ ребро КАЖДОГО выреза и берём
      // то, чья середина ближе всего к центру изображения (0.5,0.5 норм.). "Центроид
      // полигона ближе к центру" недостаточно — у стенда реальные zones.json почти все
      // status=hidden (одна плотность, нет оптического шва), контраст фетеринга виден
      // только у границы outskirts (status=known), а её ВНЕШНЕЕ ребро лежит на кромке
      // карты. Поиск по ближайшему к центру РЕБРУ (а не зоне) сам находит внутреннюю,
      // обращённую к центру часть именно этой границы.
      const geom = await page.evaluate((sel) => {
        const polys = [...document.querySelectorAll(sel)];
        if (!polys.length) return null;
        const svg = polys[0].closest('svg');
        const vb = svg.viewBox.baseVal;
        let best = null, bestDist = Infinity, bestZone = null;
        for (const poly of polys) {
          const pts = poly.getAttribute('points').trim().split(/\s+/).map((p) => p.split(',').map(Number));
          for (let i = 0; i < pts.length; i++) {
            const [x1, y1] = pts[i];
            const [x2, y2] = pts[(i + 1) % pts.length];
            const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
            const nmx = (mx - vb.x) / vb.width, nmy = (my - vb.y) / vb.height;
            const dist = Math.hypot(nmx - 0.5, nmy - 0.5);
            if (dist < bestDist) { bestDist = dist; best = { px: mx, py: my }; bestZone = poly.dataset.zone; }
          }
        }
        return { ...best, zone: bestZone };
      }, target.hazezoneSelector);
      expect(geom, `${target.label}: нет ни одного выреза тумана в DOM`).not.toBeNull();

      const { nx, ny } = await target.normOfPoint(page, geom.px, geom.py);
      await target.setViewNorm(page, nx, ny, zoom);
      await page.waitForTimeout(300);

      const mapBox = await page.locator('#map').boundingBox();
      const cropSize = 360;
      const clip = {
        x: Math.max(0, mapBox.x + mapBox.width / 2 - cropSize / 2),
        y: Math.max(0, mapBox.y + mapBox.height / 2 - cropSize / 2),
        width: cropSize,
        height: cropSize,
      };
      const file = path.join(dir, `edge-${target.key}.png`);
      await page.screenshot({ path: file, clip });
      console.log(`кроп сохранён: ${file}`);
      await page.close();
    }
  });
});
