// Ф3.3-Т: детерминированные проверки Leaflet fog-engine (?engine=leaflet) + гарантия,
// что бутстрап без флага (app.js, легаси v1) не задет. Headless — ок, ничего из этого
// не измеряет FPS (см. perf.spec.js для этого, отдельно и headed).
//
// Архитектурный принцип (обязателен для всех тестов в этом файле, см. п. (f) ТЗ):
// ожидания берутся из window.DKMapEngine (IMG_W/IMG_H/map/normToLatLng/...) и из
// текущей DOM-геометрии вырезов тумана, а не из хардкод-чисел/id зон. Ф3.4 меняет
// данные (тестовые вырезы → реальные зоны) — эти тесты обязаны пережить миграцию
// без правок.

const { test, expect } = require('@playwright/test');

// Ф3.6: после сноса v1 переключить на document — вердикт B требует нулевого
// feTurbulence во всём DOM. Пока v1 (#canvas) жив, его статический #hazeGrain
// фильтр из index.html вне периметра Ф3.3 — скоуп сузен до #map.
const FOG_SCOPE = process.env.FOG_SCOPE || '#map';

test.describe('correctness: ?engine=leaflet (Ф3.3 fog-engine)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/?engine=leaflet', { waitUntil: 'load' });
    await page.waitForFunction(() => !!(window.DKMapEngine && window.DKMapEngine.map));
  });

  test('a) DKMapEngine создан, round-trip sanity OK в консоли, тайлы без 404', async ({ page }) => {
    // console/response слушатели навешаны ПОСЛЕ первого goto в beforeEach — навигируем
    // заново в этом тесте, чтобы гарантированно перехватить лог бутстрапа и запросы тайлов.
    const consoleTexts = [];
    page.on('console', (msg) => consoleTexts.push(msg.text()));
    const tileResponses = [];
    page.on('response', (res) => {
      if (/\/tiles\/\d+\/\d+\/\d+\.png$/.test(new URL(res.url()).pathname)) tileResponses.push(res);
    });

    await page.goto('/?engine=leaflet', { waitUntil: 'load' });
    await page.waitForFunction(() => !!(window.DKMapEngine && window.DKMapEngine.map));

    const dk = await page.evaluate(() => ({
      hasMap: !!window.DKMapEngine.map,
      hasNormToLatLng: typeof window.DKMapEngine.normToLatLng === 'function',
      hasLatLngToNorm: typeof window.DKMapEngine.latLngToNorm === 'function',
      IMG_W: window.DKMapEngine.IMG_W,
      IMG_H: window.DKMapEngine.IMG_H,
    }));
    expect(dk.hasMap).toBe(true);
    expect(dk.hasNormToLatLng).toBe(true);
    expect(dk.hasLatLngToNorm).toBe(true);
    expect(dk.IMG_W).toBeGreaterThan(0);
    expect(dk.IMG_H).toBeGreaterThan(0);

    expect(consoleTexts.some((t) => t.includes('map-engine: round-trip sanity OK'))).toBe(true);
    expect(consoleTexts.some((t) => t.includes('round-trip sanity FAILED'))).toBe(false);

    await expect.poll(() => tileResponses.length, { timeout: 5000, message: 'тайлы так и не запросились' })
      .toBeGreaterThan(0);
    const statuses = tileResponses.map((r) => r.status());
    expect(statuses.filter((s) => s === 404)).toHaveLength(0);
    expect(statuses.some((s) => s === 200)).toBe(true);
  });

  test('b) вырезы тумана зафиксированы к миру на зумах [0, 2.5, 5, 7]', async ({ page }) => {
    // Геометрия — реальные зоны (Ф3.5в, data/v3/zones.json), id/координаты не хардкодятся.
    // Зоны подгружаются асинхронным fetch (не синхронно, как TEST_CUTOUTS до Ф3.4) —
    // дождаться появления хотя бы одного выреза в DOM явно, а не полагаться на 'load'.
    await page.waitForFunction(() => document.querySelectorAll('#map svg .leaf-hazezone').length > 0);
    const zoneVerts = await page.evaluate(() => {
      const { IMG_W, IMG_H } = window.DKMapEngine;
      const polys = [...document.querySelectorAll('#map svg .leaf-hazezone')];
      return polys.slice(0, 3).map((p) => {
        const [px, py] = p.getAttribute('points').trim().split(/\s+/)[0].split(',').map(Number);
        return { zone: p.dataset.zone, nx: px / IMG_W, ny: py / IMG_H, px, py };
      });
    });
    expect(zoneVerts.length, 'нужно хотя бы 2 вырeза в DOM для проверки').toBeGreaterThanOrEqual(2);

    for (const zoom of [0, 2.5, 5, 7]) {
      await page.evaluate((z) => window.DKMapEngine.map.setZoom(z, { animate: false }), zoom);
      // дать композитору применить CSS-transform оверлея после смены зума
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      await page.waitForTimeout(30);

      for (const v of zoneVerts) {
        const { expected, actual } = await page.evaluate(({ nx, ny, px, py, zone }) => {
          const DK = window.DKMapEngine;
          const ll = DK.normToLatLng(nx, ny);
          const cp = DK.map.latLngToContainerPoint(ll);
          const mapRect = document.getElementById('map').getBoundingClientRect();
          const expected = { x: mapRect.left + cp.x, y: mapRect.top + cp.y };

          const svg = document.querySelector('#map svg');
          const poly = svg.querySelector('.leaf-hazezone[data-zone="' + zone + '"]');
          const pt = svg.createSVGPoint();
          pt.x = px; pt.y = py;
          const screenPt = pt.matrixTransform(poly.getScreenCTM());
          return { expected, actual: { x: screenPt.x, y: screenPt.y } };
        }, v);

        expect(Math.abs(expected.x - actual.x), `zoom=${zoom} zone=${v.zone} x`).toBeLessThanOrEqual(2);
        expect(Math.abs(expected.y - actual.y), `zoom=${zoom} zone=${v.zone} y`).toBeLessThanOrEqual(2);
      }
    }
  });

  test(`c) в DOM нет feTurbulence в пределах ${FOG_SCOPE}`, async ({ page }) => {
    const count = await page.evaluate((scope) => document.querySelectorAll(`${scope} svg feTurbulence`).length, FOG_SCOPE);
    expect(count).toBe(0);
  });

  test('d) reveal: transition ~1.1s на вырезах тумана (computed style)', async ({ page }) => {
    await page.waitForFunction(() => !!document.querySelector('#map svg .leaf-hazezone'));
    const durMs = await page.evaluate(() => {
      const el = document.querySelector('#map svg .leaf-hazezone');
      return parseFloat(getComputedStyle(el).transitionDuration) * 1000;
    });
    expect(durMs).toBeGreaterThanOrEqual(1050);
    expect(durMs).toBeLessThanOrEqual(1150);
  });
});

test.describe('correctness: без ?engine=leaflet (легаси v1 не задет)', () => {
  test('e) app.js исполняется, #map скрыт, Leaflet не грузится', async ({ page }) => {
    const requests = [];
    page.on('request', (req) => requests.push(req.url()));

    await page.goto('/', { waitUntil: 'load' });

    // data-независимый сигнал того, что app.js реально прошёл render()/renderFog():
    // haze-on ставится на body и мировая рамка получает размер вне зависимости от
    // текущего статуса конкретных зон (в отличие от "хотя бы 1 видимая zone-полигон").
    await page.waitForFunction(() => document.body.classList.contains('haze-on'));
    const worldBorderW = await page.evaluate(() => Number(document.getElementById('worldBorder').getAttribute('width')));
    expect(worldBorderW).toBeGreaterThan(0);

    const mapDisplay = await page.evaluate(() => getComputedStyle(document.getElementById('map')).display);
    expect(mapDisplay).toBe('none');

    const hasDK = await page.evaluate(() => typeof window.DKMapEngine !== 'undefined');
    expect(hasDK).toBe(false);

    const leafletReqs = requests.filter((u) => /leaflet/i.test(u));
    expect(leafletReqs).toHaveLength(0);
  });
});
