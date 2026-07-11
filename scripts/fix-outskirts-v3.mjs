#!/usr/bin/env node
// Ф3.6-fix2 (п.3а инцидента): кольцо outskirts не дотягивает до краёв квадратного
// листа v3 (обнаружено point-in-poly разбором «рваных полос» — см. отчёт: terra
// nullius в зазоре между внешней петлёй кольца и краем листа, х∈[0,0.1877]∪[0.8125,1],
// y∈[0,0.0043]∪[0.98,1]). Правка — ТОЛЬКО внешняя петля кольца, snap каждой вершины
// по x и по y независимо к ближайшему краю листа (0 или 1). Внутренняя петля (дыра
// кольца, «keyhole»-приём — общий полигон без встроенных subpath'ов, поэтому дыра
// через bridge-ребро к общей вершине) не трогается. Остальные 9 зон, все enc-блоки
// (в т.ч. gmText самого outskirts) — байт-в-байт, полигон мутируется на месте, а не
// пересобирается объект, чтобы не менять порядок ключей JSON.
//
// Идемпотентно по построению: snap(0|1) от уже-snapped значения — то же самое
// значение, повторный прогон не меняет файл.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const ZONES_FILE = path.join(ROOT, 'data', 'v3', 'zones.json');
const OUTSKIRTS_ID = 'outskirts';

const raw = readFileSync(ZONES_FILE, 'utf8');
const doc = JSON.parse(raw);

if (doc.schema !== 'dk-map/v3' || doc.mapOrientation !== 'v3' || !Array.isArray(doc.items)) {
  throw new Error(`${ZONES_FILE}: ожидался v3-документ ({schema:'dk-map/v3', mapOrientation:'v3', items:[...]})`);
}
if (doc.items.length !== 10) {
  throw new Error(`инвариант нарушен: ожидалось 10 зон, получено ${doc.items.length}`);
}

const zone = doc.items.find((z) => z.id === OUTSKIRTS_ID);
if (!zone) throw new Error(`зона ${OUTSKIRTS_ID} не найдена в ${ZONES_FILE}`);
const poly = zone.polygon;
if (!Array.isArray(poly) || poly.length < 6) {
  throw new Error(`${OUTSKIRTS_ID}: polygon короче ожидаемого (внешняя+внутренняя петля, keyhole)`);
}

// Внешняя петля — от вершины 0 до первого повтора вершины 0 (keyhole-приём: общий
// полигон без subpath'ов, дыра — через bridge-ребро к той же точке). Внутренняя
// петля — всё после этого повтора (должна сама замыкаться тем же приёмом).
const EPS = 1e-9;
const sameVertex = (a, b) => Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS;

let outerCloseIdx = -1;
for (let i = 1; i < poly.length; i++) {
  if (sameVertex(poly[i], poly[0])) { outerCloseIdx = i; break; }
}
if (outerCloseIdx === -1) {
  throw new Error(`${OUTSKIRTS_ID}: не нашёл замыкание внешней петли (повтор вершины 0) — структура полигона не keyhole, снять скрипт с прогона и разобраться руками`);
}
const innerLoop = poly.slice(outerCloseIdx + 1);
if (innerLoop.length > 0 && !sameVertex(innerLoop[innerLoop.length - 1], innerLoop[0])) {
  throw new Error(`${OUTSKIRTS_ID}: внутренняя петля не замкнута сама на себя — структура не keyhole, снять скрипт с прогона`);
}

function snapToEdge(v) {
  return v < 0.5 ? 0 : 1;
}

const dryRun = [];
// Уникальные вершины внешней петли (без завершающего повтора) — snap независимо
// по x/y к ближайшему краю листа.
const outerUnique = poly.slice(0, outerCloseIdx);
const outerSnapped = outerUnique.map((v, i) => {
  const snapped = [snapToEdge(v[0]), snapToEdge(v[1])];
  dryRun.push({ idx: i, old: v, new: snapped });
  return snapped;
});
// Замыкающая вершина внешней петли — тот же snap, что и вершина 0 (гарантирует
// точный повтор, как в исходнике).
dryRun.push({ idx: outerCloseIdx, old: poly[outerCloseIdx], new: outerSnapped[0], note: '= вершина 0 (замыкание петли)' });

const newPolygon = [...outerSnapped, outerSnapped[0], ...innerLoop];

if (newPolygon.length !== poly.length) {
  throw new Error(`внутренняя ошибка скрипта: длина полигона изменилась (${poly.length} -> ${newPolygon.length})`);
}
for (const [x, y] of newPolygon) {
  if (!(x >= 0 && x <= 1) || !(y >= 0 && y <= 1)) {
    throw new Error(`инвариант [0,1] нарушен после snap: [${x},${y}]`);
  }
}

// --- dry-run отчёт (до записи) ---
const f4 = (n) => n.toFixed(4);
console.log('=== Ф3.6-fix2: outskirts — snap внешней петли к краям листа (dry-run, до записи) ===\n');
console.log('idx'.padEnd(5) + 'old'.padEnd(24) + 'new'.padEnd(10) + 'note');
for (const row of dryRun) {
  console.log(
    String(row.idx).padEnd(5) +
    `[${f4(row.old[0])},${f4(row.old[1])}]`.padEnd(24) +
    `[${row.new[0]},${row.new[1]}]`.padEnd(10) +
    (row.note || '')
  );
}
console.log(`\nвнутренняя петля (дыра, ${innerLoop.length} вершин, индексы ${outerCloseIdx + 1}..${poly.length - 1}) — не тронута.`);
console.log('остальные 9 зон, все enc-блоки (включая gmText самого outskirts) — не тронуты (мутируем только zone.polygon на месте).');

// --- инварианты: остальные 9 зон и enc-блоки байт-в-байт ---
const otherZonesBefore = JSON.stringify(doc.items.filter((z) => z.id !== OUTSKIRTS_ID));
const outskirtsGmTextBefore = JSON.stringify(zone.gmText);

zone.polygon = newPolygon; // мутация на месте — остальные ключи/порядок зоны не трогаем

const otherZonesAfter = JSON.stringify(doc.items.filter((z) => z.id !== OUTSKIRTS_ID));
const outskirtsGmTextAfter = JSON.stringify(zone.gmText);

if (otherZonesBefore !== otherZonesAfter) {
  throw new Error('инвариант нарушен: остальные 9 зон изменились — запись отменена');
}
if (outskirtsGmTextBefore !== outskirtsGmTextAfter) {
  throw new Error('инвариант нарушен: gmText outskirts изменился — запись отменена');
}

writeFileSync(ZONES_FILE, JSON.stringify(doc, null, 2) + '\n');
console.log(`\nЗаписано: ${path.relative(ROOT, ZONES_FILE)}`);
