// Ф3.4/Ф3.5а/world data (2026): золотой тест. Части:
//   (8а) структурная — валидная v3-обёртка (schema/mapOrientation), число зон/маркеров
//       читается из самих данных (НЕ хардкод — состав меняется правками мировых данных,
//       см. коммит "old town realigned..."), id уникальны, полигоны >=3 вершин, все
//       координаты (полигоны зон + x/y маркеров) внутри печатного листа [0,1]x[0,1].
//       ДО world data commit 8а сверял v2-геометрию с замороженным data/zones.json (v1)
//       через inverse() — это доказывало корректность СКРИПТА миграции Ф3.4 ("скрипт
//       написал одно, файл содержит другое"). Миграция закрыта, доказательство остаётся
//       в истории git; data/zones.json — мёртвый снимок, читает его только легаси app.js
//       (умирает в Ф3.6). Контент менялся в v2 через редактор (Ф3.5б) — "v2 навсегда
//       равно замороженному v1" перестал быть инвариантом в принципе, любая содержательная
//       правка геометрии его ломает. Решение Ивана: отвязать 8а от data/zones.json явно,
//       не тихим ослаблением теста. Ф3.5в: та же логика на шаг дальше — редактор
//       (js/editor-engine.js) переключён на data/v3, data/v2 заморожен как эталон
//       отката до катовера Ф3.6 (см. scripts/migrate-v3.mjs).
//   8б (была: 1:1 enc-паритет с v1 по каждому id) — retired вместе с сверкой по той же
//       причине; её содержательная часть (форма enc-блока) уже покрыта (8в)+(8г) без
//       всякой зависимости от v1.
//   (8в) нет ни одного плейнтекстового gmText в data/v3 (ни один секрет не мог
//       "потеряться" до шифра);
//   (8г) пост-ротация: все enc-блоки data/v3 несут v:2 — легаси-блок = регрессия.
//   (9)+(10) позиционная — эталонные точки queens_park/embervud: экранный пиксель из
//       normToLatLng(координаты из data/v3/markers.json) должен совпасть с фактическим
//       DOM-центром маркера (допуск 2px) на зумах [2,5], плюс скриншоты для визуальной
//       проверки направления поворота — это ГЛАВНАЯ проверка: при неверном направлении
//       формулы самосогласованы (проходят и математику, и допуск в пикселях), но
//       визуально сдвиг будет очевиден глазу.
//
// ЗАМЕНИТЬ, если Иван назовёт другие эталонные точки — сейчас это единственные два
// маркера в data/v3/markers.json, не заглушки "для примера".

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const DKCrypto = require('../js/gm-crypto.js');

const ROOT = path.join(__dirname, '..');
const GOLDEN_MARKER_IDS = ['queens_park', 'embervud'];

function readJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function inBounds01(n) { return typeof n === 'number' && n >= 0 && n <= 1; }

function isNonEmptyBase64(s) {
  if (typeof s !== 'string' || !s) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return false;
  try { return Buffer.from(s, 'base64').length > 0; } catch (e) { return false; }
}

// Легаси (без "v") и текущий v2 (v:2) — оба валидные представления (см. js/gm-crypto.js
// isEnc/isLegacyBlock). Держим это как структурный инвариант, который переживает
// scripts/rotate-passphrase.mjs без правок теста: до ротации блоки легаси, после — v2.
function isValidEncBlockShape(block) {
  if (!DKCrypto.isEnc(block)) return false;
  if ('v' in block && block.v !== 2) return false;
  return isNonEmptyBase64(block.salt) && isNonEmptyBase64(block.iv) && isNonEmptyBase64(block.ct);
}

test.describe('golden: структурные инварианты data/v3', () => {
  test('8а) v3-документы валидны: схема/штамп, состав из данных, уникальные id, геометрия в [0,1]', () => {
    const zonesV3Doc = readJSON(path.join(ROOT, 'data', 'v3', 'zones.json'));
    const markersV3Doc = readJSON(path.join(ROOT, 'data', 'v3', 'markers.json'));

    for (const doc of [zonesV3Doc, markersV3Doc]) {
      expect(doc.schema).toBe('dk-map/v3');
      expect(doc.mapOrientation).toBe('v3');
    }

    // Состав — из самих данных, не хардкод: меняется правками мировых данных.
    expect(zonesV3Doc.items.length).toBeGreaterThan(0);
    expect(markersV3Doc.items.length).toBeGreaterThan(0);

    const zoneIds = zonesV3Doc.items.map((z) => z.id);
    expect(new Set(zoneIds).size, 'дублирующийся id зоны').toBe(zoneIds.length);
    const markerIds = markersV3Doc.items.map((m) => m.id);
    expect(new Set(markerIds).size, 'дублирующийся id маркера').toBe(markerIds.length);

    for (const z of zonesV3Doc.items) {
      expect(Array.isArray(z.polygon) && z.polygon.length >= 3, `zone ${z.id}: <3 вершин`).toBe(true);
      z.polygon.forEach((pt, i) => {
        expect(inBounds01(pt[0]), `zone ${z.id} vertex ${i} x вне [0,1]`).toBe(true);
        expect(inBounds01(pt[1]), `zone ${z.id} vertex ${i} y вне [0,1]`).toBe(true);
      });
    }

    for (const m of markersV3Doc.items) {
      expect(inBounds01(m.x), `marker ${m.id} x вне [0,1]`).toBe(true);
      expect(inBounds01(m.y), `marker ${m.id} y вне [0,1]`).toBe(true);
    }
  });

  test('8в) в data/v3 нет ни одного плейнтекст-поля gmText', () => {
    const zonesV3 = readJSON(path.join(ROOT, 'data', 'v3', 'zones.json')).items;
    const markersV3 = readJSON(path.join(ROOT, 'data', 'v3', 'markers.json')).items;

    for (const it of [...zonesV3, ...markersV3]) {
      const gm = it.gmText;
      const ok = gm === '' || isValidEncBlockShape(gm);
      expect(ok, `${it.id}: gmText не пустая строка и не валидный enc-блок — похоже на утечку плейнтекста`).toBe(true);
    }
  });

  // 8г — строгий пост-ротационный гейт, ОТДЕЛЬНЫЙ от 8б (универсального, легаси-или-v2)
  // инварианта. 8б держит переходное состояние (до/после rotate --upgrade), это тест
  // держит целевое: после апгрейда легаси-блок в data/v3 — регрессия, а не норма.
  test('8г) пост-ротация: все enc-блоки data/v3 несут v:2 — легаси-блок = регрессия', () => {
    const zonesV3 = readJSON(path.join(ROOT, 'data', 'v3', 'zones.json')).items;
    const markersV3 = readJSON(path.join(ROOT, 'data', 'v3', 'markers.json')).items;

    const legacy = [];
    for (const it of [...zonesV3, ...markersV3]) {
      if (DKCrypto.isLegacyBlock(it.gmText)) legacy.push(it.id);
    }
    expect(legacy, `легаси-блоки в data/v3 (запусти scripts/rotate-passphrase.mjs --upgrade): ${legacy.join(', ')}`).toHaveLength(0);
  });
});

test.describe('golden (Ф3.4): позиция эталонных маркеров на карте', () => {
  let goldenMarkers;

  test.beforeAll(() => {
    const markersV3Doc = readJSON(path.join(ROOT, 'data', 'v3', 'markers.json'));
    goldenMarkers = GOLDEN_MARKER_IDS.map((id) => {
      const m = markersV3Doc.items.find((it) => it.id === id);
      expect(m, `эталонная точка ${id} отсутствует в data/v3/markers.json`).toBeTruthy();
      return m;
    });
  });

  test('9) экранный пиксель маркера == normToLatLng(данные v3) на зумах [2, 5]', async ({ page }) => {
    await page.goto('/', { waitUntil: 'load' });
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
    await page.goto('/', { waitUntil: 'load' });
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
