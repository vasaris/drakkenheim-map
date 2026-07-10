#!/usr/bin/env node
// Ф3.4: одноразовая миграция v1 (landscape, x/y как есть) -> v2 (портретный
// книжный разворот, повёрнутый CW). Формула (согласована с Иваном):
//   forward: (x, y) -> (1 - y, x)
//   inverse: (x, y) -> (y, 1 - x)
//
// data/zones.json и data/markers.json в HEAD НЕ трогаем — v1 остаётся эталоном
// для легаси-движка (app.js). Пишет только data/v2/{zones,markers}.json.
//
// Запуск: node scripts/migrate-v2.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const ZONES_IN = path.join(ROOT, 'data', 'zones.json');
const MARKERS_IN = path.join(ROOT, 'data', 'markers.json');
const OUT_DIR = path.join(ROOT, 'data', 'v2');
const ZONES_OUT = path.join(OUT_DIR, 'zones.json');
const MARKERS_OUT = path.join(OUT_DIR, 'markers.json');

const EPS_INVERT = 1e-12;

function forward([x, y]) { return [1 - y, x]; }
function inverse([x, y]) { return [y, 1 - x]; }

function assertUnit(n, label) {
  if (!(n >= 0 && n <= 1)) {
    throw new Error(`инвариант [0,1] нарушен: ${label} = ${n}`);
  }
}

// Защита от повторного прогона: если вход уже несёт mapOrientation v2
// (например, скрипт по ошибке repoint-нут на свой же выход), не молчим.
function loadGuarded(file) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(raw)) {
    if (raw && raw.mapOrientation === 'v2') {
      throw new Error(`${file}: вход уже несёт mapOrientation v2 — повторный прогон запрещён`);
    }
    throw new Error(`${file}: ожидался массив (v1-формат), получено ${typeof raw}`);
  }
  return raw;
}

function centroid(points) {
  const n = points.length;
  const sx = points.reduce((s, [x]) => s + x, 0);
  const sy = points.reduce((s, [, y]) => s + y, 0);
  return [sx / n, sy / n];
}

function assertEncIdentical(oldObj, newObj, label) {
  const a = JSON.stringify(oldObj.gmText);
  const b = JSON.stringify(newObj.gmText);
  if (a !== b) throw new Error(`${label}: gmText изменился при миграции — это запрещено (enc-блок должен быть побайтовой копией)`);
}

function checkRoundTrip(orig, fwd, label) {
  const back = inverse(fwd);
  if (Math.abs(back[0] - orig[0]) > EPS_INVERT || Math.abs(back[1] - orig[1]) > EPS_INVERT) {
    throw new Error(
      `${label}: round-trip не сошёлся: [${orig}] -> [${fwd}] -> [${back}], ` +
      `допуск ${EPS_INVERT}`
    );
  }
}

const zonesV1 = loadGuarded(ZONES_IN);
const markersV1 = loadGuarded(MARKERS_IN);

if (zonesV1.length !== 9) throw new Error(`инвариант нарушен: ожидалось 9 зон, получено ${zonesV1.length}`);
if (markersV1.length !== 2) throw new Error(`инвариант нарушен: ожидалось 2 маркера, получено ${markersV1.length}`);

const dryRun = [];

const zonesV2 = zonesV1.map((z) => {
  if (!Array.isArray(z.polygon) || z.polygon.length < 3) {
    throw new Error(`zone ${z.id}: polygon отсутствует или короче 3 вершин`);
  }
  const polygon = z.polygon.map((pt, i) => {
    assertUnit(pt[0], `${z.id}.polygon[${i}].x=${pt[0]}`);
    assertUnit(pt[1], `${z.id}.polygon[${i}].y=${pt[1]}`);
    const fwd = forward(pt);
    assertUnit(fwd[0], `${z.id}.polygon[${i}].new_x=${fwd[0]}`);
    assertUnit(fwd[1], `${z.id}.polygon[${i}].new_y=${fwd[1]}`);
    checkRoundTrip(pt, fwd, `zone ${z.id} vertex ${i}`);
    return fwd;
  });

  dryRun.push({
    kind: 'zone', id: z.id,
    oldFirst: z.polygon[0], newFirst: polygon[0],
    oldCentroid: centroid(z.polygon), newCentroid: centroid(polygon),
  });

  return { ...z, polygon };
});

const markersV2 = markersV1.map((m) => {
  assertUnit(m.x, `${m.id}.x=${m.x}`);
  assertUnit(m.y, `${m.id}.y=${m.y}`);
  const [nx, ny] = forward([m.x, m.y]);
  assertUnit(nx, `${m.id}.new_x=${nx}`);
  assertUnit(ny, `${m.id}.new_y=${ny}`);
  checkRoundTrip([m.x, m.y], [nx, ny], `marker ${m.id}`);

  dryRun.push({
    kind: 'marker', id: m.id,
    oldFirst: [m.x, m.y], newFirst: [nx, ny],
    oldCentroid: [m.x, m.y], newCentroid: [nx, ny],
  });

  return { ...m, x: nx, y: ny };
});

zonesV1.forEach((z, i) => assertEncIdentical(z, zonesV2[i], `zone ${z.id}`));
markersV1.forEach((m, i) => assertEncIdentical(m, markersV2[i], `marker ${m.id}`));

// --- dry-run отчёт (до записи) ---
const f4 = (n) => n.toFixed(4);
console.log('=== Ф3.4 миграция v1 -> v2 (dry-run, до записи файлов) ===');
console.log(`объектов: зоны ${zonesV1.length}, маркеры ${markersV1.length}, итого ${dryRun.length}\n`);
console.log(
  'kind'.padEnd(7) + 'id'.padEnd(14) +
  'first old'.padEnd(20) + 'first new'.padEnd(20) +
  'centroid old'.padEnd(20) + 'centroid new'
);
for (const row of dryRun) {
  console.log(
    row.kind.padEnd(7) + row.id.padEnd(14) +
    `[${f4(row.oldFirst[0])},${f4(row.oldFirst[1])}]`.padEnd(20) +
    `[${f4(row.newFirst[0])},${f4(row.newFirst[1])}]`.padEnd(20) +
    `[${f4(row.oldCentroid[0])},${f4(row.oldCentroid[1])}]`.padEnd(20) +
    `[${f4(row.newCentroid[0])},${f4(row.newCentroid[1])}]`
  );
}

// --- запись: только data/v2/, data/*.json в HEAD не трогаем ---
mkdirSync(OUT_DIR, { recursive: true });
const wrap = (items) => ({ schema: 'dk-map/v2', mapOrientation: 'v2', items });
writeFileSync(ZONES_OUT, JSON.stringify(wrap(zonesV2), null, 2) + '\n');
writeFileSync(MARKERS_OUT, JSON.stringify(wrap(markersV2), null, 2) + '\n');

console.log(`\nЗаписано: ${path.relative(ROOT, ZONES_OUT)}`);
console.log(`Записано: ${path.relative(ROOT, MARKERS_OUT)}`);
console.log('data/zones.json и data/markers.json НЕ тронуты (v1 остаётся эталоном для app.js).');
