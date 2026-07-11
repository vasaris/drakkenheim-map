// Ф3.6-fix2в: редизайн тумана. Туман войны (per-zone статусные вырезы, union разных
// плотностей по data/v3/zones.json, reveal-transition на смену статуса) ОТМЕНЁН ПОЛНОСТЬЮ.
// Вместо него — атмосферная Дымка в два слоя одной вуали:
//   1) базовая Дымка — весь лист, РАВНОМЕРНАЯ плотность (не зависит от статуса зон
//      вообще — статусы от тумана отвязаны, см. window.DKFog ниже), blur ~34.5
//      (формула стенда, не менялась), breathe 17s (вердикт B, не менялась).
//   2) Deep Haze — полигоны из data/v3/haze.json (канон DoD, не игровые статусы),
//      заметно плотнее базовой; kind="crater" — максимальная плотность. СТАТИЧЕН,
//      без своего breathe (канонично: глубина «стоит как пелена», не дышит).
//      Перф-изоляция (замер, 3 варианта x 3 повтора, headed, static 10s):
//      phase-sync=0 (обе анимации в такт)      -> dropped% не улучшился (~12%, было ~13%)
//      Deep Haze без анимации, база дышит      -> dropped% = 0%, paintCount = 0
//      обе статичны (контроль)                  -> ~0% (N слишком мал, некомпаративно)
//      Причина: .leaf-haze-deep/.leaf-haze-crater лежат ВНУТРИ filter="url(#leafHazeFeather)" —
//      анимация их opacity форсит перерисовку (feGaussianBlur на весь мир) каждый кадр;
//      .leaf-fog-rect снаружи фильтра — чистый композиторный opacity, paintCount=0.
//      Синхронизация фаз не помогает, т.к. дело не в рассинхроне, а в самом факте
//      анимирования свойства внутри отфильтрованной группы.
// Deep Haze не показывается в попапах/панели — игрок видит его на карте глазами,
// этого достаточно (механика — в GM-заметках, вне приложения).
//
// Механизм рендера (SVG-оверлей, маска, feGaussianBlur по краям) — портирован из
// стенда ~/Downloads/dk-spike (вердикт B, зафиксировано, не обсуждается) и не менялся
// этим фиксом: тот же mask/filter, меняется только ЧТО в него кладётся.
//   - feTurbulence/grain НЕ добавляется вовсе — даже отключённым, мёртвый фильтр в DOM
//     стоит памяти iOS-композитора (см. dk-spike ?grain=0 сравнение).
//
// Координаты — только через normToLatLng() из map-engine.js (window.DKMapEngine);
// свой пересчёт норм-координат в пиксели здесь не заводится.
(function () {
  var DK = window.DKMapEngine;
  if (!DK) {
    console.error('fog-engine: window.DKMapEngine не найден — map-engine.js должен грузиться раньше');
    return;
  }

  var FEATHER_STD = DK.MASTER_SIZE / 145; // формула стенда dk-spike — не менялась этим фиксом

  // Три плотности вуали (mask luminance -> alpha базового fogRect). База — заметно
  // светлее (плотнее) пустого места, но НЕ максимум — Deep Haze и тем более kind=crater
  // обязаны читаться «заметно плотнее/гуще» на её фоне, как просил Иван.
  var BASE_FILL = '#9a9a9a';   // базовая Дымка — равномерно по всему листу
  var DEEP_FILL = '#e0e0e0';   // Deep Haze (kind=deep) — заметно плотнее базовой
  var CRATER_FILL = '#ffffff'; // kind=crater — максимальная плотность

  var SVGNS = 'http://www.w3.org/2000/svg';
  function el(tag, attrs) {
    var e = document.createElementNS(SVGNS, tag);
    for (var k in (attrs || {})) e.setAttribute(k, attrs[k]);
    return e;
  }

  // Норм-координаты -> SVG-пиксели оверлея. Единственный переход — через
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
    // Ф3.6-fix2в: reveal-transition (fill 1.1s на смену статуса зоны) убран целиком —
    // Deep Haze больше не меняет форму/плотность в рантайме (грузится один раз из
    // haze.json и живёт статично), менять-с-анимацией больше нечего.
    // Перф-фикс (см. шапку файла): Deep Haze/crater БЕЗ анимации — внутри отфильтрованной
    // группы breathe форсил перерисовку feGaussianBlur каждый кадр, дал измеренные дропы.
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
  // Базовая Дымка — весь лист, одна плотность, без статусной логики.
  maskG.appendChild(el('rect', {x: 0, y: 0, width: DK.IMG_W, height: DK.IMG_H, fill: BASE_FILL}));
  mask.appendChild(maskG);
  defs.appendChild(mask);
  svg.appendChild(defs);

  var fogRect = el('rect', {
    'class': 'leaf-fog-rect', width: DK.IMG_W, height: DK.IMG_H, fill: '#5e4488',
    mask: 'url(#leafFogMask)', 'pointer-events': 'none'
  });
  svg.appendChild(fogRect);

  L.svgOverlay(svg, DK.bounds, {interactive: false, pane: 'overlayPane'}).addTo(DK.map);

  // Ф3.6-fix2в: статусы зон (data/v3/zones.json) ОТВЯЗАНЫ от тумана — туман больше не
  // читает zones.json вообще, поэтому DKFog.syncZone/removeZone больше нечего делать с
  // маской. Оставлены как no-op — editor-engine.js вызывает их при рисовании/правке/
  // удалении зоны (Ф3.5б, «статус зоны немедленно в тумане»), это поведение отменено
  // этим фиксом, но сам editor-engine.js не трогаем (см. бриф) — no-op безопаснее, чем
  // удалять экспорт и чинить все места вызова.
  window.DKFog = {
    syncZone: function () {},
    removeZone: function () {},
  };

  // Ф3.6-fix2в: Deep Haze — канон DoD (Dungeons of Drakkenheim, «Haze map»), не
  // игровые данные, поэтому отдельный файл, не zones.json. kind="crater" — максимальная
  // плотность (см. CRATER_FILL), остальные — DEEP_FILL. Рисуем ПОСЛЕ базового rect
  // (тот же документ-order, что и раньше — последний в maskG красится поверх, см.
  // отчёт Ф3.6-fix2б) — здесь порядок между областями Deep Haze не важен, они не
  // перекрываются между собой в каноне.
  fetch('data/v3/haze.json', {cache: 'no-store'})
    .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
    .then(function (data) {
      var areas = (data && data.areas) || [];
      areas.forEach(function (a) {
        if (!a.polygon || a.polygon.length < 3) return;
        var isCrater = a.kind === 'crater';
        maskG.appendChild(el('polygon', {
          'class': isCrater ? 'leaf-haze-crater' : 'leaf-haze-deep',
          'data-haze': a.id,
          points: a.polygon.map(function (p) { return normPointToSvg(p[0], p[1]); }).join(' '),
          fill: isCrater ? CRATER_FILL : DEEP_FILL
        }));
      });
      console.log('fog-engine: overlay attached, ' + areas.length + ' Deep Haze areas (data/v3/haze.json)');
    })
    .catch(function (err) {
      console.error('fog-engine: не удалось загрузить data/v3/haze.json', err);
    });
})();
