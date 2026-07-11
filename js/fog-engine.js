// Ф3.3: Дымка (туман войны) Leaflet-движка.
//
// Механизм и параметры — портированы из стенда ~/Downloads/dk-spike (вердикт B,
// зафиксировано, не обсуждается):
//   - SVG-оверлей (L.svgOverlay), маска «тьма с вырезами», feGaussianBlur по краям;
//   - stdDeviation см. FEATHER_STD ниже — формула стенда (world_max/145), где world_max —
//     сторона мастера. v2 (книжный разворот, IMG_W=3300≠IMG_H=5100) не мог применить эту
//     формулу к прод-ширине буквально (стенд landscape 5100x3300 давал другое число) —
//     держали литерал 5100/145. Ф3.5в: мир v3 КВАДРАТНЫЙ (MASTER_SIZE=IMG_W=IMG_H) —
//     формула снова применима как есть, без литерала;
//   - breathe-анимация 17s, reveal-transition (смена fill выреза) 1.1s;
//   - feTurbulence/grain НЕ добавляется вовсе — даже отключённым, мёртвый фильтр в DOM
//     стоит памяти iOS-композитора (см. dk-spike ?grain=0 сравнение).
//
// Координаты вырезов — только через normToLatLng() из map-engine.js (window.DKMapEngine);
// свой пересчёт норм-координат в пиксели здесь не заводится.
(function () {
  var DK = window.DKMapEngine;
  if (!DK) {
    console.error('fog-engine: window.DKMapEngine не найден — map-engine.js должен грузиться раньше');
    return;
  }

  var FEATHER_STD = DK.MASTER_SIZE / 145; // формула стенда dk-spike — см. комментарий в шапке файла
  var FOG_HEX = {hidden: '#ebebeb', known: '#6b6b6b', scouted: '#262626', explored: '#000000'};

  var SVGNS = 'http://www.w3.org/2000/svg';
  function el(tag, attrs) {
    var e = document.createElementNS(SVGNS, tag);
    for (var k in (attrs || {})) e.setAttribute(k, attrs[k]);
    return e;
  }

  // Норм-координаты выреза -> SVG-пиксели оверлея. Единственный переход — через
  // normToLatLng (map-engine.js) + map.project на NATIVE_Z; своих IMG_W/IMG_H тут не используем.
  function normPointToSvg(nx, ny) {
    var p = DK.map.project(DK.normToLatLng(nx, ny), DK.NATIVE_Z);
    return p.x + ',' + p.y;
  }

  var style = document.createElement('style');
  style.textContent =
    '.leaf-fog-rect{opacity:.96;}' +
    '.leaf-fog-anim .leaf-fog-rect{animation:leafHazeBreathe 17s ease-in-out infinite alternate;}' +
    '@keyframes leafHazeBreathe{from{opacity:.9;}to{opacity:1;}}' +
    '.leaf-hazezone{transition:fill 1.1s ease;}' +
    '@media (prefers-reduced-motion:reduce){.leaf-fog-anim .leaf-fog-rect{animation:none;opacity:.96;}}';
  document.head.appendChild(style);

  var svg = el('svg', {viewBox: '0 0 ' + DK.IMG_W + ' ' + DK.IMG_H, 'class': 'leaf-fog-anim'});

  var defs = el('defs');
  var feather = el('filter', {
    id: 'leafHazeFeather', x: '-6%', y: '-6%', width: '112%', height: '112%',
    'color-interpolation-filters': 'sRGB'
  });
  feather.appendChild(el('feGaussianBlur', {stdDeviation: FEATHER_STD}));
  defs.appendChild(feather);

  var mask = el('mask', {id: 'leafFogMask'});
  var maskG = el('g', {id: 'leafFogMaskG', filter: 'url(#leafHazeFeather)'});
  maskG.appendChild(el('rect', {x: 0, y: 0, width: DK.IMG_W, height: DK.IMG_H, fill: FOG_HEX.hidden}));
  mask.appendChild(maskG);
  defs.appendChild(mask);
  svg.appendChild(defs);

  var fogRect = el('rect', {
    'class': 'leaf-fog-rect', width: DK.IMG_W, height: DK.IMG_H, fill: '#5e4488',
    mask: 'url(#leafFogMask)', 'pointer-events': 'none'
  });
  svg.appendChild(fogRect);

  L.svgOverlay(svg, DK.bounds, {interactive: false, pane: 'overlayPane'}).addTo(DK.map);

  // Ф3.5б: живой хук для js/editor-engine.js — статус зоны должен «немедленно отражаться
  // в тумане» (решение по спорному 2: Дымка остаётся видимой и во время редактирования,
  // в отличие от v1, который её на время EDIT гасит целиком). Не переоткрывает исходный
  // fetch — правит уже существующий DOM-узел maskG напрямую (та же техника, что и
  // app.js renderFog: querySelector по data-zone, замена fill/points на месте).
  // syncZone — upsert (создаёт вырез, если зона новая; иначе обновляет форму/цвет).
  window.DKFog = {
    syncZone: function (zone) {
      if (!zone || !zone.polygon || zone.polygon.length < 3) return;
      var pts = zone.polygon.map(function (p) { return normPointToSvg(p[0], p[1]); }).join(' ');
      var node = maskG.querySelector('.leaf-hazezone[data-zone="' + zone.id + '"]');
      if (!node) {
        node = el('polygon', { 'class': 'leaf-hazezone', 'data-zone': zone.id });
        maskG.appendChild(node);
      }
      node.setAttribute('points', pts);
      node.setAttribute('fill', FOG_HEX[zone.status] || FOG_HEX.hidden);
    },
    removeZone: function (id) {
      var node = maskG.querySelector('.leaf-hazezone[data-zone="' + id + '"]');
      if (node) node.remove();
    },
  };

  // Ф3.5в: реальные зоны из data/v3/zones.json (мигрированные на русский квадратный
  // мастер). Загрузка асинхронная — вырезы появляются в маске чуть позже, чем сам оверлей
  // монтируется на карту; это ожидаемо (см. tests/correctness.spec.js, ждёт
  // .leaf-hazezone явно, а не полагается на синхронность).
  fetch('data/v3/zones.json', {cache: 'no-store'})
    .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
    .then(function (data) {
      var zones = (data && data.items) || [];
      // Ф3.6-fix2б: outskirts красит весь лист (внутренняя дыра убрана — см.
      // fix-outskirts-nohole-v3.mjs), городские зоны обязаны рисоваться ПОСЛЕ
      // неё, чтобы их плотность легла поверх (SVG-маска красит перекрытие по
      // обычному document order — последний рисуется поверх, подтверждено рендер-
      // тестом в отчёте). data/v3/zones.json на момент фикса несёт outskirts
      // первой записью, но порядок в JSON-массиве — не гарантия сама по себе
      // (редактор может его когда-нибудь переставить) — сортируем явно здесь,
      // а не полагаемся молча на порядок файла.
      zones = zones.slice().sort(function (a, b) {
        return (a.id === 'outskirts' ? 0 : 1) - (b.id === 'outskirts' ? 0 : 1);
      });
      zones.forEach(function (z) {
        if (!z.polygon || z.polygon.length < 3) return;
        maskG.appendChild(el('polygon', {
          'class': 'leaf-hazezone', 'data-zone': z.id,
          points: z.polygon.map(function (p) { return normPointToSvg(p[0], p[1]); }).join(' '),
          fill: FOG_HEX[z.status] || FOG_HEX.hidden
        }));
      });
      console.log('fog-engine: overlay attached, ' + zones.length + ' zones (data/v3/zones.json)');
    })
    .catch(function (err) {
      console.error('fog-engine: не удалось загрузить data/v3/zones.json', err);
    });
})();
