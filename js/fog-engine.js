// Ф3.3: Дымка (туман войны) для Leaflet-движка (?engine=leaflet).
// Только эта ветка бутстрапа — app.js и его renderFog (v1) не трогаются.
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

  var Q = new URLSearchParams(location.search);

  // Ф3.5в: реальные зоны из data/v3/zones.json (мигрированные на русский квадратный
  // мастер). Загрузка асинхронная — вырезы появляются в маске чуть позже, чем сам оверлей
  // монтируется на карту; это ожидаемо (см. tests/correctness.spec.js, ждёт
  // .leaf-hazezone явно, а не полагается на синхронность).
  fetch('data/v3/zones.json', {cache: 'no-store'})
    .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
    .then(function (data) {
      var zones = (data && data.items) || [];
      zones.forEach(function (z) {
        if (!z.polygon || z.polygon.length < 3) return;
        maskG.appendChild(el('polygon', {
          'class': 'leaf-hazezone', 'data-zone': z.id,
          points: z.polygon.map(function (p) { return normPointToSvg(p[0], p[1]); }).join(' '),
          fill: FOG_HEX[z.status] || FOG_HEX.hidden
        }));
      });
      console.log('fog-engine: overlay attached, ' + zones.length + ' zones (data/v3/zones.json)');

      // ---- временный демо-хук reveal (?fogdemo=1) — TEMP, убрать в Ф3.6 вместе с ?fps=1 HUD.
      // Целевая зона — первая со status=known на момент загрузки (сейчас это 'outskirts'),
      // не хардкод id: если данные поменяются, демо просто возьмёт другую известную зону.
      if (Q.get('fogdemo') === '1') {
        var demoZone = zones.filter(function (z) { return z.status === 'known'; })[0] || zones[0];
        if (demoZone) {
          var demoPoly = maskG.querySelector('.leaf-hazezone[data-zone="' + demoZone.id + '"]');
          var open = false;
          setInterval(function () {
            open = !open;
            demoPoly.setAttribute('fill', open ? FOG_HEX.explored : FOG_HEX.known);
            console.log('fogdemo: ' + demoZone.id + ' ->', open ? 'explored' : 'known');
          }, 2500);
        } else {
          console.warn('fogdemo: нет ни одной зоны для демо-реveal');
        }
      }
    })
    .catch(function (err) {
      console.error('fog-engine: не удалось загрузить data/v3/zones.json', err);
    });

  // ---- временный FPS-HUD (?fps=1[&auto=1]) — TEMP, убрать в Ф3.6 вместе с ?fogdemo=1.
  // Методика 1:1 со стендом dk-spike: тот же rAF-счётчик (окно 500ms, скользящий worst5s
  // за 5с), тот же hop-стресс (4 точки/зума, flyTo 2.5s, суммарно 20s) для сценария «пан».
  // Grain/blur-тумблеры стенда сюда не портируются — в проде это не параметры (grain
  // не существует вовсе, blur — фиксированный литерал), сравнивать их нечего.
  if (Q.get('fps') === '1') {
    var hud = document.createElement('div');
    hud.style.cssText = 'position:fixed;top:8px;left:8px;z-index:9999;' +
      'font:12px monospace;background:rgba(0,0,0,.7);color:#0f0;' +
      'padding:4px 8px;pointer-events:none;';
    var fpsLine = document.createElement('div');
    fpsLine.textContent = 'FPS: --';
    var cfgLine = document.createElement('div');
    cfgLine.textContent = 'cfg: leaflet fog-engine (blur=' + FEATHER_STD.toFixed(1) + ' anim=17s)';
    cfgLine.style.color = '#ccc';
    hud.appendChild(fpsLine);
    hud.appendChild(cfgLine);
    document.body.appendChild(hud);

    var last = performance.now();
    var winStart = last, frames = 0, worstWin = 0;
    var recent = []; // плоские пары [t, dt] за последние 5с — прунится раз в окно, не в кадр

    function tick(now) {
      var dt = now - last; last = now;
      frames++;
      if (dt > worstWin) worstWin = dt;
      recent.push(now, dt);

      if (now - winStart >= 500) {
        var cutoff = now - 5000;
        var pruned = [];
        var worst5 = 0;
        for (var i = 0; i < recent.length; i += 2) {
          if (recent[i] >= cutoff) {
            pruned.push(recent[i], recent[i + 1]);
            if (recent[i + 1] > worst5) worst5 = recent[i + 1];
          }
        }
        recent = pruned;
        var fps = frames * 1000 / (now - winStart);
        fpsLine.textContent = 'FPS ' + fps.toFixed(0) +
          ' | worst ' + worstWin.toFixed(0) + 'ms' +
          ' | worst5s ' + worst5.toFixed(0) + 'ms';
        fpsLine.style.color = fps < 25 ? '#f33' : fps < 45 ? '#ff0' : '#0f0';
        window.__fpsStats = {fps: fps, worstMs: worstWin, worst5sMs: worst5};
        if (window.__fpsRec) window.__fpsRec.push(fps, worstWin);
        frames = 0; worstWin = 0; winStart = now;
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);

    // ---- пан-стресс (?fps=1&auto=1): 4 точки/зума, как на стенде, 20с, авто-отчёт ----
    if (Q.get('auto') === '1') {
      var autoLine = document.createElement('div');
      autoLine.style.color = '#8cf';
      hud.appendChild(autoLine);

      function runStress() {
        var RUN_MS = 20000;
        var points = [
          [DK.normToLatLng(0.5, 0.5), 7],
          [DK.normToLatLng(0.1, 0.1), 2],
          [DK.normToLatLng(0.9, 0.9), 7],
          [DK.normToLatLng(0.5, 0.5), 3]
        ];
        var pi = 0, finished = false;
        var t0 = performance.now();
        window.__fpsStats = null;
        window.__fpsRec = [];
        var timer = setInterval(function () {
          var remain = Math.max(0, RUN_MS - (performance.now() - t0)) / 1000;
          autoLine.textContent = 'AUTO пан-стресс: осталось ~' + Math.round(remain) + 'с';
          if (performance.now() - t0 >= RUN_MS + 5000 && !finished) finish();
        }, 500);

        function hop() {
          if (performance.now() - t0 >= RUN_MS) return finish();
          var pz = points[pi % points.length];
          pi++;
          DK.map.once('moveend', hop);
          DK.map.flyTo(pz[0], pz[1], {duration: 2.5});
        }
        function finish() {
          if (finished) return;
          finished = true;
          clearInterval(timer);
          DK.map.stop();
          var rec = window.__fpsRec || [];
          window.__fpsRec = null;
          var sum = 0, min = Infinity, worst = 0, n = 0;
          for (var i = 0; i < rec.length; i += 2) {
            sum += rec[i]; n++;
            if (rec[i] < min) min = rec[i];
            if (rec[i + 1] > worst) worst = rec[i + 1];
          }
          var stats = n ? {
            avgFps: +(sum / n).toFixed(1),
            minFps: +min.toFixed(1),
            worstMs: +worst.toFixed(0)
          } : {avgFps: 0, minFps: 0, worstMs: 0};
          autoLine.textContent = 'AUTO готово: avg ' + stats.avgFps + ' | min ' + stats.minFps + ' | worst ' + stats.worstMs + 'ms';
          console.log('AUTO pan-stress results:', JSON.stringify(stats));
          window.__autoResults = stats;
        }
        hop();
      }

      DK.map.whenReady(function () { setTimeout(runStress, 1000); });
    }
  }
})();
