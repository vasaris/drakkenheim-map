// Ф3.4: золотой тест. Две части:
//   (8) математическая — миграция v1->v2 инвертируема, штамп на месте, gmText не тронут
//       (перепроверяется против РЕАЛЬНЫХ файлов data/v2/*.json, не против результата
//       скрипта в памяти — ловит расхождение "скрипт написал одно, файл содержит другое");
//   (9)+(10) позиционная — эталонные точки queens_park/embervud: экранный пиксель из
//       normToLatLng(координаты из data/v2/markers.json) должен совпасть с фактическим
//       DOM-центром маркера (допуск 2px) на зумах [2,5], плюс скриншоты для визуальной
//       проверки направления поворота — это ГЛАВНАЯ проверка: при неверном направлении
//       формулы самосогласованы (проходят и математику, и допуск в пикселях), но
//       визуально сдвиг будет очевиден глазу.
//
// ЗАМЕНИТЬ, если Иван назовёт другие эталонные точки — сейчас это единственные два
// маркера в data/markers.json, не заглушки "для примера".

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EPS_INVERT = 1e-12;
const GOLDEN_MARKER_IDS = ['queens_park', 'embervud'];

function inverse([x, y]) { return [y, 1 - x]; }

function readJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

test.describe('golden (Ф3.4): математика миграции', () => {
  test('8) v2 файлы инвертируются в v1, штамп на месте, gmText побайтово идентичен', () => {
    const zonesV1 = readJSON(path.join(ROOT, 'data', 'zones.json'));
    const markersV1 = readJSON(path.join(ROOT, 'data', 'markers.json'));
    const zonesV2Doc = readJSON(path.join(ROOT, 'data', 'v2', 'zones.json'));
    const markersV2Doc = readJSON(path.join(ROOT, 'data', 'v2', 'markers.json'));

    for (const doc of [zonesV2Doc, markersV2Doc]) {
      expect(doc.schema).toBe('dk-map/v2');
      expect(doc.mapOrientation).toBe('v2');
    }

    expect(zonesV2Doc.items).toHaveLength(9);
    expect(markersV2Doc.items).toHaveLength(2);
    expect(zonesV1).toHaveLength(9);
    expect(markersV1).toHaveLength(2);

    const zonesV1ById = Object.fromEntries(zonesV1.map((z) => [z.id, z]));
    for (const z2 of zonesV2Doc.items) {
      const z1 = zonesV1ById[z2.id];
      expect(z1, `zone ${z2.id}: нет пары в v1`).toBeTruthy();
      expect(JSON.stringify(z2.gmText), `zone ${z2.id}: gmText изменился`).toBe(JSON.stringify(z1.gmText));
      expect(z2.polygon.length, `zone ${z2.id}: число вершин изменилось`).toBe(z1.polygon.length);
      z2.polygon.forEach((pt, i) => {
        const back = inverse(pt);
        expect(Math.abs(back[0] - z1.polygon[i][0]), `zone ${z2.id} vertex ${i} x`).toBeLessThanOrEqual(EPS_INVERT);
        expect(Math.abs(back[1] - z1.polygon[i][1]), `zone ${z2.id} vertex ${i} y`).toBeLessThanOrEqual(EPS_INVERT);
      });
    }

    const markersV1ById = Object.fromEntries(markersV1.map((m) => [m.id, m]));
    for (const m2 of markersV2Doc.items) {
      const m1 = markersV1ById[m2.id];
      expect(m1, `marker ${m2.id}: нет пары в v1`).toBeTruthy();
      expect(JSON.stringify(m2.gmText), `marker ${m2.id}: gmText изменился`).toBe(JSON.stringify(m1.gmText));
      const back = inverse([m2.x, m2.y]);
      expect(Math.abs(back[0] - m1.x), `marker ${m2.id} x`).toBeLessThanOrEqual(EPS_INVERT);
      expect(Math.abs(back[1] - m1.y), `marker ${m2.id} y`).toBeLessThanOrEqual(EPS_INVERT);
    }
  });
});

test.describe('golden (Ф3.4): позиция эталонных маркеров на карте', () => {
  let goldenMarkers;

  test.beforeAll(() => {
    const markersV2Doc = readJSON(path.join(ROOT, 'data', 'v2', 'markers.json'));
    goldenMarkers = GOLDEN_MARKER_IDS.map((id) => {
      const m = markersV2Doc.items.find((it) => it.id === id);
      expect(m, `эталонная точка ${id} отсутствует в data/v2/markers.json`).toBeTruthy();
      return m;
    });
  });

  test('9) экранный пиксель маркера == normToLatLng(данные v2) на зумах [2, 5]', async ({ page }) => {
    await page.goto('/?engine=leaflet', { waitUntil: 'load' });
    await page.waitForFunction(() => !!(window.DKMapEngine && window.DKMapEngine.map));
    for (const m of goldenMarkers) {
      await page.waitForFunction((id) => !!document.querySelector(`.dk-marker[data-marker-id="${id}"]`), m.id);
    }

    for (const zoom of [2, 5]) {
      await page.evaluate((z) => window.DKMapEngine.map.setZoom(z, { animate: false }), zoom);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      await page.waitForTimeout(30);

      for (const m of goldenMarkers) {
        const { expected, actual } = await page.evaluate(({ x, y, id }) => {
          const DK = window.DKMapEngine;
          const ll = DK.normToLatLng(x, y);
          const cp = DK.map.latLngToContainerPoint(ll);
          const mapRect = document.getElementById('map').getBoundingClientRect();
          const expected = { x: mapRect.left + cp.x, y: mapRect.top + cp.y };

          const el = document.querySelector(`.dk-marker[data-marker-id="${id}"]`);
          const r = el.getBoundingClientRect();
          const actual = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          return { expected, actual };
        }, { x: m.x, y: m.y, id: m.id });

        expect(Math.abs(expected.x - actual.x), `zoom=${zoom} ${m.id} x`).toBeLessThanOrEqual(2);
        expect(Math.abs(expected.y - actual.y), `zoom=${zoom} ${m.id} y`).toBeLessThanOrEqual(2);
      }
    }
  });

  test('10) скриншоты эталонных точек для визуальной проверки направления', async ({ page }) => {
    const dir = path.join(ROOT, 'artifacts');
    fs.mkdirSync(dir, { recursive: true });

    await page.setViewportSize({ width: 1000, height: 800 });
    await page.goto('/?engine=leaflet', { waitUntil: 'load' });
    await page.waitForFunction(() => !!(window.DKMapEngine && window.DKMapEngine.map));
    for (const m of goldenMarkers) {
      await page.waitForFunction((id) => !!document.querySelector(`.dk-marker[data-marker-id="${id}"]`), m.id);
    }

    for (const m of goldenMarkers) {
      await page.evaluate(({ x, y }) => {
        const DK = window.DKMapEngine;
        DK.map.setView(DK.normToLatLng(x, y), 5, { animate: false });
      }, { x: m.x, y: m.y });
      await page.waitForTimeout(300);

      const file = path.join(dir, `golden-${m.id}.png`);
      await page.locator('#map').screenshot({ path: file });
      console.log(`golden-скриншот сохранён: ${file}`);
    }
  });
});
