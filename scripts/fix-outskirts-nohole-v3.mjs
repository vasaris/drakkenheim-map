#!/usr/bin/env node
// Ф3.6-fix2б: внутренняя дыра кольца outskirts читалась искусственным прямоугольником
// на квадратном листе (ре-приёмка Ивана). Замер (рендер-тест, см. отчёт): SVG-маска
// красит перекрытие вырезов по обычному порядку отрисовки (последний в document order
// побеждает) — ПОДТВЕРЖДЕНО контролируемым рендер-тестом на живой странице (первая
// попытка замера дала обратный результат из-за инлайн-style Leaflet — width/height в
// style у svg.leaf-fog-anim перебивает атрибуты width/height, из-за чего клон
// рендерился в разрешении 743px вместо 5000px; без style — порядок отрисовки ведёт
// себя штатно). outskirts — первая зона в data/v3/zones.json (индекс 0), все 9
// городских зон идут позже и рисуются ПОВЕРХ неё — значит дыра не нужна вовсе: убираем
// внутреннюю петлю, внешняя (уже snap'нута к краям листа в fix-outskirts-v3.mjs)
// становится единственным контуром outskirts, городские зоны сами перекрывают её своей
// плотностью через обычный порядок отрисовки.
//
// Инварианты — как в fix-outskirts-v3.mjs: остальные 9 зон и все enc-блоки (включая
// gmText outskirts) байт-в-байт, полигон мутируется на месте (порядок ключей JSON не
// трогаем). Идемпотентно по построению — если внутренней петли уже нет, скрипт это
// обнаруживает и завершается без записи.

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

const zoneIdx = doc.items.findIndex((z) => z.id === OUTSKIRTS_ID);
if (zoneIdx === -1) throw new Error(`зона ${OUTSKIRTS_ID} не найдена в ${ZONES_FILE}`);
if (zoneIdx !== 0) {
  throw new Error(
    `${OUTSKIRTS_ID}: находится на позиции ${zoneIdx}, не 0 — фикс полагается на то, что outskirts ` +
    `рисуется ПЕРВОЙ (все городские зоны должны перекрывать её поверх). Прогон отменён — ` +
    `разобраться руками, почему порядок изменился, прежде чем убирать дыру.`
  );
}
const zone = doc.items[zoneIdx];
const poly = zone.polygon;
if (!Array.isArray(poly) || poly.length < 4) {
  throw new Error(`${OUTSKIRTS_ID}: polygon короче ожидаемого`);
}

const EPS = 1e-9;
const sameVertex = (a, b) => Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS;

let outerCloseIdx = -1;
for (let i = 1; i < poly.length; i++) {
  if (sameVertex(poly[i], poly[0])) { outerCloseIdx = i; break; }
}

if (outerCloseIdx === -1) {
  // Нет повтора первой вершины — либо дыры уже нет (идемпотентность), либо структура
  // не keyhole вовсе. Отличаем по длине: без дыры внешняя петля — просто N вершин без
  // повтора. Ничего не меняем.
  console.log(`${OUTSKIRTS_ID}: повтор вершины 0 не найден — дыры уже нет (идемпотентно), файл не тронут.`);
  process.exit(0);
}

const outerLoop = poly.slice(0, outerCloseIdx); // без завершающего повтора вершины 0
const innerLoop = poly.slice(outerCloseIdx + 1);

if (outerLoop.length !== 4) {
  throw new Error(`${OUTSKIRTS_ID}: внешняя петля несёт ${outerLoop.length} вершин, ожидалось 4 (после snap к краям листа) — снять скрипт с прогона, разобраться руками`);
}
for (const [x, y] of outerLoop) {
  if (!((x === 0 || x === 1) && (y === 0 || y === 1))) {
    throw new Error(`${OUTSKIRTS_ID}: внешняя вершина [${x},${y}] не в углу листа (0/1) — сначала прогони fix-outskirts-v3.mjs`);
  }
}

console.log('=== Ф3.6-fix2б: outskirts — убрать внутреннюю дыру (dry-run, до записи) ===\n');
console.log(`внешняя петля (${outerLoop.length} вершин, углы листа): ${JSON.stringify(outerLoop)}`);
console.log(`внутренняя петля (дыра, ${innerLoop.length} вершин, индексы ${outerCloseIdx + 1}..${poly.length - 1}) — УДАЛЯЕТСЯ.`);
console.log('остальные 9 зон, все enc-блоки (включая gmText outskirts) — не тронуты.');
console.log(`outskirts остаётся на позиции 0 (рисуется первой; 9 городских зон перекрывают её поверх — см. рендер-тест в отчёте).`);

const otherZonesBefore = JSON.stringify(doc.items.filter((z) => z.id !== OUTSKIRTS_ID));
const outskirtsGmTextBefore = JSON.stringify(zone.gmText);

zone.polygon = outerLoop; // мутация на месте — дыра убрана, внешний контур не тронут

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
