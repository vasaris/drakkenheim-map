#!/usr/bin/env node
// Ф3.5в: одноразовая миграция v2 (портретный разворот 3300x5100, повёрнутый CW) ->
// v3 (квадратный мир, русский мастер-растр). В отличие от Ф3.4 (migrate-v2.mjs),
// это НЕ точная геометрическая формула — v2 и v3 это два разных растра (разные
// исходники книги), поэтому связь между ними найдена эмпирически: 11 контрольных
// точек (кратер, замок, X-перекрёсток, 5 ворот, 2 южных перекрёстка, южная
// развилка), нормированная кросс-корреляция патчей между растрами, субпиксельный
// пик по параболе, least-squares аффинный фит. Невязка (max по 11 точкам,
// в пикселях исходного 5000x5000 RU-растра): 0.62px. Компас (12-я точка,
// v2_y=4468, у южного края) исключён из фита как выброс (~79px невязка при
// проверке против остальных 11 точек, сходящихся к <1.3px вплоть до v2_y=4090) —
// вероятная ложная привязка на 4-кратно симметричном орнаменте, не геометрия.
// Подробности и кропы — отчёт Ф3.5в фаза А (чат с Иваном, 2026-07-11).
//
// Коэффициенты аффинного преобразования (v2 pixel-space 3300x5100 -> v3
// normalized [0,1], где v3 pixel-space при фите было 5000x5000 — итог в
// normalized-координатах, поэтому НЕ зависит от того, 5000 или 10000 у
// итогового мастера v3, лишь бы композиция/кадрирование растра не менялись):
//   x3n = (A*x2 + B*y2 + C) / V3_FIT_PX
//   y3n = (D*x2 + E*y2 + F) / V3_FIT_PX
//   где x2 = nx_v2*3300, y2 = ny_v2*5100
const A = 0.9658660729604566, B = 0.00013204823619327022, C = 906.4648616736575;
const D = -5.1841055655312445e-05, E = 0.9662014491477116, F = -2.8715892372246348;

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const ZONES_IN = path.join(ROOT, 'data', 'v2', 'zones.json');
const MARKERS_IN = path.join(ROOT, 'data', 'v2', 'markers.json');
const OUT_DIR = path.join(ROOT, 'data', 'v3');
const ZONES_OUT = path.join(OUT_DIR, 'zones.json');
const MARKERS_OUT = path.join(OUT_DIR, 'markers.json');

const V2_W = 3300, V2_H = 5100;
const V3_FIT_PX = 5000; // растр, на котором подгонялись контрольные точки (см. шапку)

// Эмбервуд — не через аффинный фит: маркер у самого южного края (v2_y=4743,
// глубже точки схождения фита y<=4090 и совсем рядом с исключённым компасом),
// экстраполяция ненадёжна. Иван измерил напрямую на RU-растре — кончик
// булавки-указателя перед подписью «В деревню Эмбервуд» (метод как в Ф3.4
// со стрелкой): normalized (0.7590, 0.9226). Аффинный фит для сравнения дал
// бы (0.7679, 0.9159) — разница ~70px на 5000px растре, экстраполяционная
// ошибка, не шум измерения.
const EMBERVUD_OVERRIDE = { x: 0.7590, y: 0.9226 };

const ROUND_TRIP_EPS = 1e-9; // проверяет матрицу обращения в этом файле, не геометрию

function forward([nx, ny]) {
  const x2 = nx * V2_W, y2 = ny * V2_H;
  const x3 = A * x2 + B * y2 + C;
  const y3 = D * x2 + E * y2 + F;
  return [x3 / V3_FIT_PX, y3 / V3_FIT_PX];
}

// Алгебраическое обращение линейной части [[A,B],[D,E]] — проверяет, что
// формула обращения в этом файле не содержит опечатки (транспонирование,
// знак и т.п.). НЕ доказывает геометрическую точность фита — та подтверждена
// невязкой 0.62px по контрольным точкам (см. шапку), не round-trip'ом.
const DET = A * E - B * D;
function inverse([nx3, ny3]) {
  const x3 = nx3 * V3_FIT_PX, y3 = ny3 * V3_FIT_PX;
  const cx = x3 - C, cy = y3 - F;
  const x2 = (E * cx - B * cy) / DET;
  const y2 = (-D * cx + A * cy) / DET;
  return [x2 / V2_W, y2 / V2_H];
}

function assertUnit(n, label) {
  if (!(n >= 0 && n <= 1)) {
    throw new Error(`инвариант [0,1] нарушен: ${label} = ${n}`);
  }
}

// Защита от повторного прогона.
function loadGuarded(file) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  if (raw && raw.mapOrientation === 'v3') {
    throw new Error(`${file}: вход уже несёт mapOrientation v3 — повторный прогон запрещён`);
  }
  if (!raw || raw.mapOrientation !== 'v2' || !Array.isArray(raw.items)) {
    throw new Error(`${file}: ожидался v2-документ ({mapOrientation:'v2', items:[...]})`);
  }
  return raw.items;
}

// Отказ при повторном прогоне: вход всегда data/v2 (он не помечается), поэтому
// защита должна смотреть на ВЫХОД — если data/v3 уже сгенерирован, тихая
// перезапись запрещена (можно затереть ручные правки/уже закоммиченное).
function refuseIfOutputExists(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (raw && raw.mapOrientation === 'v3') {
      throw new Error(
        `${file}: уже существует и несёт mapOrientation v3 — повторный прогон запрещён. ` +
        `Удали data/v3/ вручную, если миграцию нужно перегенерировать.`
      );
    }
  } catch (e) {
    if (e.code === 'ENOENT') return; // выхода ещё нет — можно писать
    throw e;
  }
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
  if (Math.abs(back[0] - orig[0]) > ROUND_TRIP_EPS || Math.abs(back[1] - orig[1]) > ROUND_TRIP_EPS) {
    throw new Error(
      `${label}: round-trip не сошёлся: [${orig}] -> [${fwd}] -> [${back}], ` +
      `допуск ${ROUND_TRIP_EPS} (это баг обращения матрицы в скрипте, не геометрии)`
    );
  }
}

refuseIfOutputExists(ZONES_OUT);
refuseIfOutputExists(MARKERS_OUT);

const zonesV2 = loadGuarded(ZONES_IN);
const markersV2 = loadGuarded(MARKERS_IN);

if (zonesV2.length !== 10) throw new Error(`инвариант нарушен: ожидалось 10 зон, получено ${zonesV2.length}`);
if (markersV2.length !== 2) throw new Error(`инвариант нарушен: ожидалось 2 маркера, получено ${markersV2.length}`);

const dryRun = [];

const zonesV3 = zonesV2.map((z) => {
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
    oldCentroid: centroid(z.polygon), newCentroid: centroid(polygon),
  });

  return { ...z, polygon };
});

const markersV3 = markersV2.map((m) => {
  assertUnit(m.x, `${m.id}.x=${m.x}`);
  assertUnit(m.y, `${m.id}.y=${m.y}`);
  const [fx, fy] = forward([m.x, m.y]);
  assertUnit(fx, `${m.id}.fit_x=${fx}`);
  assertUnit(fy, `${m.id}.fit_y=${fy}`);
  checkRoundTrip([m.x, m.y], [fx, fy], `marker ${m.id}`);

  let nx = fx, ny = fy, overridden = false;
  if (m.id === 'embervud') {
    nx = EMBERVUD_OVERRIDE.x;
    ny = EMBERVUD_OVERRIDE.y;
    overridden = true;
  }
  assertUnit(nx, `${m.id}.new_x=${nx}`);
  assertUnit(ny, `${m.id}.new_y=${ny}`);

  dryRun.push({
    kind: 'marker', id: m.id,
    oldCentroid: [m.x, m.y], newCentroid: [nx, ny],
    fitCentroid: overridden ? [fx, fy] : null,
  });

  return { ...m, x: nx, y: ny };
});

zonesV2.forEach((z, i) => assertEncIdentical(z, zonesV3[i], `zone ${z.id}`));
markersV2.forEach((m, i) => assertEncIdentical(m, markersV3[i], `marker ${m.id}`));

// --- dry-run отчёт (до записи) ---
const f4 = (n) => n.toFixed(4);
console.log('=== Ф3.5в миграция v2 -> v3 (dry-run, до записи файлов) ===');
console.log(`объектов: зоны ${zonesV2.length}, маркеры ${markersV2.length}, итого ${dryRun.length}\n`);
console.log(
  'kind'.padEnd(7) + 'id'.padEnd(24) +
  'centroid old'.padEnd(20) + 'centroid new'.padEnd(20) + 'note'
);
for (const row of dryRun) {
  const note = row.fitCentroid
    ? `override, фит дал бы [${f4(row.fitCentroid[0])},${f4(row.fitCentroid[1])}]`
    : '';
  console.log(
    row.kind.padEnd(7) + row.id.padEnd(24) +
    `[${f4(row.oldCentroid[0])},${f4(row.oldCentroid[1])}]`.padEnd(20) +
    `[${f4(row.newCentroid[0])},${f4(row.newCentroid[1])}]`.padEnd(20) +
    note
  );
}

// --- запись: только data/v3/, data/v2/ в HEAD не трогаем (эталон отката до катовера) ---
mkdirSync(OUT_DIR, { recursive: true });
const wrap = (items) => ({ schema: 'dk-map/v3', mapOrientation: 'v3', items });
writeFileSync(ZONES_OUT, JSON.stringify(wrap(zonesV3), null, 2) + '\n');
writeFileSync(MARKERS_OUT, JSON.stringify(wrap(markersV3), null, 2) + '\n');

console.log(`\nЗаписано: ${path.relative(ROOT, ZONES_OUT)}`);
console.log(`Записано: ${path.relative(ROOT, MARKERS_OUT)}`);
console.log('data/v2/*.json НЕ тронуты (остаются эталоном отката до катовера Ф3.6).');
