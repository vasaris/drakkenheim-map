// Ф3.5б: авторский режим для Leaflet-движка (?engine=leaflet) — порт редактора v1
// (app.js: рисование зон, маркеры, формы, экспорт) на события Leaflet, без Leaflet.draw.
// app.js НЕ трогается (умрёт в Ф3.6) — это параллельная, самостоятельная реализация.
//
// Доступен ТОЛЬКО в разлоченном Мастер-режиме (см. window.DKGM.onChange ниже) — отдельного
// ?edit=1 на этой ветке нет. Данные сразу в v3-формате (schema/mapOrientation/items),
// без миграций. Черновик — localStorage (ключи ниже), «экспорт» отдаёт готовые
// data/v3/{zones,markers}.json файлы для ручного коммита — пайплайн деплоя не меняется.
//
// Решения по спорным местам плана (чат, все — «ок»):
//  1) gmText шифруется НА КАЖДОЕ сохранение (debounce), не только на экспорт как в v1 —
//     иначе несохранённая GM-заметка терялась бы при рефреше (реальный пробел v1).
//  2) Дымка остаётся ЖИВОЙ во время редактирования (v1 её выключает целиком) — иначе
//     «немедленно отражается в тумане» нечем проверить внутри самой сессии правки.
//  3) Read-панель Ф3.5а (gm-engine.js renderPanel) — выкинута, эта форма её заменяет.
//  4) «Импорт» — НЕ реализован; «Данные» = экспорт + «Сбросить правки», как в v1.
//  5) Конфликт с репо — простое сравнение baseline/live (stableStringify), без field-merge.
//  6) id новых объектов — С random-суффиксом (не только Date.now(), см. genId): при
//     AAD=id коллизия — это не только дублирующийся id, а неразличимость крипто-контекстов
//     двух разных объектов и тихая перезапись в черновике; суффикс ничего не стоит.
//  7) Подпись зоны/маркера на карте — L.Tooltip(permanent) вместо своего div-icon.
(function () {
  var DK = window.DKMapEngine;
  var DKCrypto = window.DKCrypto;
  if (!DK) { console.error('editor-engine: window.DKMapEngine не найден — map-engine.js должен грузиться раньше'); return; }
  if (!DKCrypto) { console.error('editor-engine: window.DKCrypto не найден — gm-crypto.js должен грузиться раньше'); return; }
  if (!window.DKGM) { console.error('editor-engine: window.DKGM не найден — gm-engine.js должен грузиться раньше'); return; }
  if (!window.DKFog) { console.error('editor-engine: window.DKFog не найден — fog-engine.js должен грузиться раньше'); return; }
  if (!window.DKMarkers) { console.error('editor-engine: window.DKMarkers не найден — markers-engine.js должен грузиться раньше'); return; }

  var $ = function (s) { return document.querySelector(s); };

  var STATUS_COLOR = { hidden: '#5a5566', known: '#5b76b8', scouted: '#c19036', explored: '#5fae74' };
  var STATUS_LABEL = { hidden: 'Скрыто', known: 'Слух', scouted: 'Разведано', explored: 'Открыто' };
  var MARKER_COLOR = { location: '#c9a85f', faction: '#5b76b8', danger: '#c5453f', secret: '#b06ae0', hub: '#5fae74' };
  var TYPE_LABEL = { location: 'Локация', faction: 'Фракция', danger: 'Опасность', secret: 'Секрет', hub: 'Хаб' };

  var LS_WORK = 'dk_work_v3';           // {zones:[...], markers:[...]} — черновик, v3-shape items
  var LS_BASELINE = 'dk_work_v3_baseline'; // {zones:[...], markers:[...]} — снимок live-данных на момент черновика

  // ?gmfixture=1 / =empty — те же фикстуры, что у gm-engine.js (см. tests/gm.spec.js);
  // отдельных editor-фикстур не заводим, формат v2-документа одинаковый для обеих целей.
  var Q = new URLSearchParams(location.search);
  var fx = Q.get('gmfixture');
  var ZONES_URL = fx === 'empty' ? 'tests/fixtures/gm-empty-zones.json'
    : fx === 'lifecycle' ? 'tests/fixtures/lifecycle-zones.json'
    : fx ? 'tests/fixtures/gm-fixture-zones.json'
    : 'data/v3/zones.json';
  var MARKERS_URL = fx === 'empty' ? 'tests/fixtures/gm-empty-markers.json'
    : fx === 'lifecycle' ? 'tests/fixtures/lifecycle-markers.json'
    : fx ? 'tests/fixtures/gm-fixture-markers.json'
    : 'data/v3/markers.json';

  var zones = [], markers = [];
  var sel = null;            // {kind:'zone'|'marker', id}
  var drawing = null;        // {points:[[nx,ny]...], redraw?, id?}
  var placingMarker = false;
  var conflict = false;
  var pendingLive = null;    // последняя живая серверная копия — источник для «Сбросить правки»

  var zoneLayerGroup = L.layerGroup();
  var markerLayerGroup = L.layerGroup();
  var drawPreviewLayer = null;
  var gmDebounceTimers = {};

  /* ---------- утилиты ---------- */
  function esc(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function readJSON(s) { try { return JSON.parse(s); } catch (e) { return null; } }
  function stableStringify(v) {
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    if (v && typeof v === 'object') {
      var keys = Object.keys(v).sort();
      return '{' + keys.map(function (k) { return JSON.stringify(k) + ':' + stableStringify(v[k]); }).join(',') + '}';
    }
    return JSON.stringify(v);
  }
  // Решение по спорному 6: random-суффикс поверх Date.now() — коллизия id при AAD=id
  // означает не просто дублирующийся id, а неразличимые крипто-контексты двух объектов.
  function genId(prefix) { return prefix + Date.now() + '-' + Math.random().toString(36).slice(2, 8); }
  function pointInPoly(x, y, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  function zoneAt(x, y) {
    for (var i = 0; i < zones.length; i++) {
      var z = zones[i];
      if (z.polygon && z.polygon.length >= 3 && pointInPoly(x, y, z.polygon)) return z;
    }
    return null;
  }

  // Живая приёмка: подпись outskirts (зона-кольцо: внешний контур + обратный внутренний,
  // fill-rule=evenodd — см. data/v3/zones.json) висела в дырке кольца, посреди чужих
  // районов — среднее вершин (центроид) лежит вне полигона у невыпуклых/кольцевых форм.
  // distToPolyEdges/labelAnchor — грубый однопроходный аналог "визуального центра"
  // (то же, что решает Mapbox polylabel, без его quadtree-уточнения — точности сетки
  // хватает для якоря надписи, зон всего 9, пересчёт разовый на рендер слоя).
  function distToSegment(px, py, x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1;
    var lenSq = dx * dx + dy * dy;
    var t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    var cx = x1 + t * dx, cy = y1 + t * dy;
    return Math.hypot(px - cx, py - cy);
  }
  function distToPolyEdges(x, y, poly) {
    var min = Infinity;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var d = distToSegment(x, y, poly[j][0], poly[j][1], poly[i][0], poly[i][1]);
      if (d < min) min = d;
    }
    return min;
  }
  // Приоритет якоря — внутри полигона И внутри печатного листа [0,1]x[0,1] (живая приёмка:
  // подпись у самой кромки резалась границей #map/растра). distToSheetEdge — клиренс до
  // края листа, наравне с клиренсом до рёбер полигона: итоговый скор — минимум из двух,
  // максимизируем его же. Для совсем узких пристеночных зон, где даже лучшая точка вплотную
  // к краю, текст всё равно может не влезать на дальних зумах — за это отвечает
  // updateLabelClipping() ниже (прячет по факту реального переполнения, не по гео-эвристике).
  // direction — куда Leaflet вешает текст ОТ якоря. 'center' центрирует — половина текста
  // уходит в сторону ближайшего края листа и режется там же, где сам якорь и так у кромки
  // (живая приёмка: именно так резался outskirts). Для пристеночных якорей текст вешаем
  // ОТ края внутрь листа (ближе edge слева -> текст растёт вправо, и т.д.), а не поровну.
  // Расстояния переводим в реальные пиксели листа (DK.IMG_W/IMG_H) — на v2 (книжный
  // портрет, выше чем шире) сырое сравнение нормализованных x/y вводило в заблуждение:
  // маленькая нормализованная разница по Y могла означать бОльшее реальное расстояние,
  // чем по X, и наоборот. Ф3.5в: мир v3 квадратный (IMG_W===IMG_H) — искажение ушло, но
  // код оставлен как есть (без него не отличить top/bottom прижим от left/right, а именно
  // в этом ошибка была поймана на живом outskirts, см. историю).
  function edgeAwayDirection(x, y) {
    var dLeft = x * DK.IMG_W, dRight = (1 - x) * DK.IMG_W;
    var dTop = y * DK.IMG_H, dBottom = (1 - y) * DK.IMG_H;
    var m = Math.min(dLeft, dRight, dTop, dBottom);
    if (m === dLeft) return 'right';
    if (m === dRight) return 'left';
    if (m === dTop) return 'bottom';
    return 'top';
  }
  function labelAnchor(poly) {
    var cx = 0, cy = 0;
    poly.forEach(function (p) { cx += p[0]; cy += p[1]; });
    cx /= poly.length; cy /= poly.length;
    if (pointInPoly(cx, cy, poly) && cx >= 0 && cx <= 1 && cy >= 0 && cy <= 1) {
      return { point: [cx, cy], direction: 'center' };
    }

    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    poly.forEach(function (p) {
      if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
    });
    // сужаем область поиска до пересечения bbox зоны с листом — если оно есть
    var sMinX = Math.max(minX, 0), sMaxX = Math.min(maxX, 1);
    var sMinY = Math.max(minY, 0), sMaxY = Math.min(maxY, 1);
    var hasSheetOverlap = sMinX <= sMaxX && sMinY <= sMaxY;
    var searchMinX = hasSheetOverlap ? sMinX : minX, searchMaxX = hasSheetOverlap ? sMaxX : maxX;
    var searchMinY = hasSheetOverlap ? sMinY : minY, searchMaxY = hasSheetOverlap ? sMaxY : maxY;

    var STEPS = 24;
    var best = [cx, cy], bestDist = -1; // на случай вырожденного полигона — тот же fallback, что раньше
    for (var i = 0; i <= STEPS; i++) {
      for (var j = 0; j <= STEPS; j++) {
        var x = searchMinX + (searchMaxX - searchMinX) * i / STEPS;
        var y = searchMinY + (searchMaxY - searchMinY) * j / STEPS;
        if (!pointInPoly(x, y, poly)) continue;
        var d = Math.min(distToPolyEdges(x, y, poly), x, 1 - x, y, 1 - y);
        if (d > bestDist) { bestDist = d; best = [x, y]; }
      }
    }
    return { point: best, direction: hasSheetOverlap ? edgeAwayDirection(best[0], best[1]) : 'center' };
  }
  function fetchJSON(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status + ' ' + url));
    });
  }

  /* ---------- данные: живой сервер + localStorage-черновик ---------- */
  function loadLive() {
    return Promise.all([fetchJSON(ZONES_URL), fetchJSON(MARKERS_URL)]).then(function (res) {
      return { zones: (res[0] && res[0].items) || [], markers: (res[1] && res[1].items) || [] };
    });
  }
  function writeBaseline(live) { localStorage.setItem(LS_BASELINE, JSON.stringify(live)); }
  function writeDraft() { localStorage.setItem(LS_WORK, JSON.stringify({ zones: zones, markers: markers })); }
  function saveDraft() { writeDraft(); }

  // Загружается заново на каждый unlock (см. enable()) — ловит и репо-изменения, случившиеся
  // пока вкладка была заперта, а не только на первой загрузке страницы.
  function loadData() {
    return loadLive().then(function (live) {
      pendingLive = live;
      var draft = readJSON(localStorage.getItem(LS_WORK));
      if (draft && Array.isArray(draft.zones) && Array.isArray(draft.markers)) {
        zones = draft.zones; markers = draft.markers;
        var baseline = readJSON(localStorage.getItem(LS_BASELINE));
        if (baseline) {
          conflict = stableStringify(baseline) !== stableStringify(live);
        } else {
          writeBaseline(live); conflict = false;
        }
      } else {
        zones = live.zones; markers = live.markers;
        writeBaseline(live);
        conflict = false;
      }
    });
  }
  function resetToRepo() {
    localStorage.removeItem(LS_WORK);
    zones = pendingLive.zones.slice();
    markers = pendingLive.markers.slice();
    writeBaseline({ zones: zones, markers: markers });
    conflict = false;
    sel = null;
    renderZonesLayer(); renderMarkersLayer(); renderPanel();
    toast('Загружено из репозитория');
  }

  /* ---------- крипто (сессионный ключ — из gm-engine.js, никогда не свой) ---------- */
  function encryptGmText(id, plaintext) {
    if (!plaintext) return Promise.resolve('');
    var ks = window.DKGM.getKeyAndSalt();
    if (!ks) return Promise.reject(new Error('GM key unavailable'));
    return DKCrypto.aesEncrypt(ks.key, ks.salt, plaintext, id);
  }
  function decryptGmText(obj) {
    if (!DKCrypto.isEnc(obj.gmText)) return Promise.resolve(typeof obj.gmText === 'string' ? obj.gmText : '');
    var ks = window.DKGM.getKeyAndSalt();
    if (!ks) return Promise.reject(new Error('GM key unavailable'));
    var legacy = DKCrypto.isLegacyBlock(obj.gmText);
    return DKCrypto.aesDecrypt(ks.key, obj.gmText, legacy ? undefined : obj.id);
  }
  function scheduleGmSave(kind, obj, plaintext) {
    var key = kind + ':' + obj.id;
    clearTimeout(gmDebounceTimers[key]);
    gmDebounceTimers[key] = setTimeout(function () {
      encryptGmText(obj.id, plaintext).then(function (block) {
        obj.gmText = block;
        saveDraft();
      }).catch(function (e) { console.error('editor-engine: encrypt gmText failed', e); });
    }, 400);
  }

  /* ---------- рисование зоны / размещение маркера ---------- */
  function renderDrawPreview() {
    if (drawPreviewLayer) { drawPreviewLayer.remove(); drawPreviewLayer = null; }
    if (!drawing) return;
    var latlngs = drawing.points.map(function (p) { return DK.normToLatLng(p[0], p[1]); });
    var group = L.layerGroup();
    if (latlngs.length >= 2) {
      L.polygon(latlngs, { color: '#c9a85f', weight: 2, dashArray: '6 5', fillColor: '#c9a85f', fillOpacity: .14, interactive: false }).addTo(group);
    }
    latlngs.forEach(function (ll) {
      L.circleMarker(ll, { radius: 5, color: '#c9a85f', fillColor: '#c9a85f', fillOpacity: 1, weight: 1, interactive: false }).addTo(group);
    });
    group.addTo(DK.map);
    drawPreviewLayer = group;
  }
  function toggleDrawZone() {
    if (drawing) { finishZone(); return; }
    drawing = { points: [] };
    renderDrawPreview();
    renderPanel();
    toast('Кликай углы, Enter — готово');
  }
  function finishZone() {
    var pts = drawing.points;
    if (pts.length < 3) { cancelDraw(); toast('Нужно ≥3 точек'); return; }
    if (drawing.redraw) {
      var z = zones.find(function (x) { return x.id === drawing.id; });
      if (z) { z.polygon = pts; window.DKFog.syncZone(z); }
      sel = { kind: 'zone', id: drawing.id };
    } else {
      var id = genId('z');
      var z2 = { id: id, name: 'Новая зона', band: '', owner: '[TBD]', status: 'hidden', playerText: '', gmText: '', polygon: pts };
      zones.push(z2);
      window.DKFog.syncZone(z2);
      sel = { kind: 'zone', id: id };
    }
    drawing = null;
    if (drawPreviewLayer) { drawPreviewLayer.remove(); drawPreviewLayer = null; }
    saveDraft();
    renderZonesLayer(); renderMarkersLayer(); renderPanel();
    toast('Зона сохранена');
  }
  function cancelDraw() {
    drawing = null; placingMarker = false;
    if (drawPreviewLayer) { drawPreviewLayer.remove(); drawPreviewLayer = null; }
    renderPanel();
  }
  function placeMarkerAt(latlng) {
    var norm = DK.latLngToNorm(latlng);
    var x = norm[0], y = norm[1];
    var zone = zoneAt(x, y);
    var id = genId('m');
    var m = { id: id, name: '', visibleName: 'Новый маркер', type: 'location', zone: zone ? zone.id : '', status: 'hidden', playerText: '', gmText: '', x: x, y: y };
    markers.push(m);
    placingMarker = false;
    sel = { kind: 'marker', id: id };
    saveDraft();
    renderZonesLayer(); renderMarkersLayer(); renderPanel();
    toast('Маркер сохранён');
  }

  DK.map.on('click', function (e) {
    if (!window.DKGM.isUnlocked()) return;
    if (drawing) { drawing.points.push(DK.latLngToNorm(e.latlng)); renderDrawPreview(); return; }
    if (placingMarker) { placeMarkerAt(e.latlng); return; }
  });

  // Живая приёмка: 9 реальных районов плотно замащивают центр листа, подписи касались/
  // наезжали друг на друга (Южный/Кратер/Храмовый) при zoomSnap-дефолте fitBounds
  // (map-engine.js). Текст L.Tooltip НЕ масштабируется вместе с картой на zoom (в отличие
  // от SVG-полигонов) — держим отдельную CSS-переменную размера подписи, пересчитываем
  // на zoomend. Диапазон подобран эмпирически по скриншотам на дефолтном виде «в размер»
  // (обычно zoom 1-3 для книжного разворота): 8px — нижний предел читаемости, 13px —
  // близко к исходным 12px на большом приближении. Диапазон эмпирический — подобран на
  // v2 книжном развороте (NATIVE_Z=5, maxZoom=7 на тот момент); NATIVE_Z/maxZoom теперь
  // выводятся из MASTER_SIZE (map-engine.js) и меняются при переключении мастера v3 на
  // финальное разрешение — перепроверить визуально на живом виде, когда апскейл готов.
  function updateLabelSize() {
    var zoom = DK.map.getZoom();
    var size = Math.round(Math.min(13, Math.max(8, 7 + zoom)));
    document.documentElement.style.setProperty('--dk-editor-zlabel-size', size + 'px');
  }

  // Живая приёмка: даже с приоритетом «якорь внутри листа» (labelAnchor) у зон вплотную
  // к кромке на дальних зумах тексту физически не хватает места — резалось краем #map.
  // Меряем РЕАЛЬНОЕ переполнение (bounding rect подписи против экранной проекции листа
  // [0,1]x[0,1]), не гео-эвристику — учитывает фактическую длину текста/шрифт/зум, а не
  // приближение. getBoundingClientRect() форсит синхронный layout — вызывать сразу после
  // рендера тултипов безопасно, без setTimeout.
  function updateLabelClipping() {
    var tl = DK.map.latLngToContainerPoint(DK.normToLatLng(0, 0));
    var br = DK.map.latLngToContainerPoint(DK.normToLatLng(1, 1));
    var mapRect = document.getElementById('map').getBoundingClientRect();
    var sheetLeft = mapRect.left + Math.min(tl.x, br.x);
    var sheetRight = mapRect.left + Math.max(tl.x, br.x);
    var sheetTop = mapRect.top + Math.min(tl.y, br.y);
    var sheetBottom = mapRect.top + Math.max(tl.y, br.y);
    document.querySelectorAll('.dk-editor-zlabel').forEach(function (el) {
      var r = el.getBoundingClientRect();
      var overflows = r.left < sheetLeft || r.right > sheetRight || r.top < sheetTop || r.bottom > sheetBottom;
      el.style.display = overflows ? 'none' : '';
    });
  }
  DK.map.on('zoomend', function () { updateLabelSize(); updateLabelClipping(); });
  updateLabelSize();

  /* ---------- слой зон/маркеров авторского вида (все объекты, кликабельны для выбора) ---------- */
  function select(kind, id) {
    sel = { kind: kind, id: id };
    renderZonesLayer(); renderMarkersLayer();
    renderPanel();
  }
  function renderZonesLayer() {
    zoneLayerGroup.clearLayers();
    zones.forEach(function (z) {
      if (!z.polygon || z.polygon.length < 3) return;
      var latlngs = z.polygon.map(function (p) { return DK.normToLatLng(p[0], p[1]); });
      var isSel = !!(sel && sel.kind === 'zone' && sel.id === z.id);
      var col = STATUS_COLOR[z.status] || STATUS_COLOR.hidden;
      var poly = L.polygon(latlngs, {
        color: col, weight: isSel ? 3.5 : 2, fillColor: col, fillOpacity: isSel ? .42 : .28,
        className: 'dk-editor-zone' + (isSel ? ' sel' : ''),
      });
      // Тултип НЕ бинжу на сам полигон: Leaflet ставит direction:'center' по центру его
      // bbox, а не по геометрическому центроиду — для невыпуклых/кольцевых форм (outskirts)
      // bbox-центр проваливается в дырку. labelAnchor() считает якорь сам (центроид, если
      // он внутри полигона; иначе — точка внутри, максимально удалённая от рёбер), якорь —
      // невидимый CircleMarker без взаимодействия, клики по-прежнему только на полигоне.
      // direction — от edgeAwayDirection: для пристеночных якорей текст растёт от края
      // внутрь листа, не поровну в обе стороны (иначе половина всё равно резалась бы).
      var anchor = labelAnchor(z.polygon);
      L.circleMarker(DK.normToLatLng(anchor.point[0], anchor.point[1]), { radius: 0, opacity: 0, fillOpacity: 0, interactive: false })
        .bindTooltip(z.name || '', { permanent: true, direction: anchor.direction, className: 'dk-editor-zlabel' })
        .addTo(zoneLayerGroup);
      poly.on('click', function (e) {
        if (drawing || placingMarker) return; // не перехватываем клики точек рисования
        L.DomEvent.stopPropagation(e);
        select('zone', z.id);
      });
      // data-zone-id — тот же приём, что data-marker-id в markers-engine.js: нужен тестам
      // (и потенциально другим модулям), чтобы адресовать конкретный полигон среди многих,
      // не только "первый .dk-editor-zone". renderZonesLayer каждый раз пересоздаёт слой
      // с нуля (clearLayers), поэтому 'add' стреляет и при первом монтировании тоже.
      poly.on('add', function () {
        var el = poly.getElement();
        if (el) el.setAttribute('data-zone-id', z.id);
      });
      poly.addTo(zoneLayerGroup);
    });
    updateLabelClipping(); // свежесозданные тултипы ещё не проверены на переполнение листа
  }
  function renderMarkersLayer() {
    markerLayerGroup.clearLayers();
    markers.forEach(function (m) {
      var isSel = !!(sel && sel.kind === 'marker' && sel.id === m.id);
      var icon = L.divIcon({
        className: 'dk-marker dk-marker-' + (m.type || 'location') + (isSel ? ' sel' : ''),
        html: '<span class="dk-marker-dot" style="background:' + (MARKER_COLOR[m.type] || MARKER_COLOR.location) + '"></span>',
        iconSize: [16, 16], iconAnchor: [8, 8],
      });
      var mk = L.marker(DK.normToLatLng(m.x, m.y), { icon: icon, keyboard: false });
      var label = m.name || m.visibleName || 'маркер'; // EDIT-конвенция v1: внутреннее имя приоритетнее
      mk.bindTooltip(label, { permanent: true, direction: 'top', offset: [0, -10], className: 'dk-editor-mlabel' });
      mk.on('click', function (e) {
        if (drawing || placingMarker) return;
        L.DomEvent.stopPropagation(e);
        select('marker', m.id);
      });
      mk.addTo(markerLayerGroup);
      var el = mk.getElement();
      if (el) el.setAttribute('data-marker-id', m.id);
    });
  }

  /* ---------- панель: инструменты + форма выбранного объекта ---------- */
  function legendHtml() {
    return ['hidden', 'known', 'scouted', 'explored'].map(function (s) {
      return '<span><i style="background:' + STATUS_COLOR[s] + '"></i>' + STATUS_LABEL[s].toLowerCase() + '</span>';
    }).join('');
  }
  function conflictBannerHtml() {
    return '<div class="sec"><div class="gmlock conflict-banner">' +
      'Данные в репозитории изменились с начала правок.' +
      '<div class="btnrow"><button class="btn" id="conflictKeep">Продолжить с черновиком</button>' +
      '<button class="btn warn" id="conflictReset">Сбросить черновик</button></div>' +
      '</div></div>';
  }
  function statusButtonsHtml(obj) {
    var cur = obj.status;
    function b(s) { return '<button class="sb-' + s + ' ' + (cur === s ? 'on' : '') + '" data-status="' + s + '">' + STATUS_LABEL[s] + '</button>'; }
    return '<div class="statusgrid">' + b('hidden') + b('known') + b('scouted') + b('explored') + '</div>';
  }
  function zoneEditorHtml(z) {
    return '<div class="sec">' +
      '<h3>Зона <span class="pill-band">' + esc(z.band || '—') + '</span></h3>' +
      '<label>Название</label><input type="text" id="z_name" value="' + esc(z.name) + '">' +
      '<div class="row">' +
      '<div><label>Пояс</label><input type="text" id="z_band" value="' + esc(z.band || '') + '"></div>' +
      '<div><label>Владелец</label><input type="text" id="z_owner" value="' + esc(z.owner || '') + '"></div>' +
      '</div>' +
      '<label>Статус открытия</label>' + statusButtonsHtml(z) +
      '<label>Текст для игроков</label><textarea id="z_ptext">' + esc(z.playerText || '') + '</textarea>' +
      '<label>Заметки автора (GM · шифруется)</label><textarea id="z_gtext" disabled placeholder="расшифровка…"></textarea>' +
      '<div class="btnrow">' +
      '<button class="btn" id="z_redraw">Перерисовать контур</button>' +
      '<button class="btn warn" id="z_del">Удалить</button>' +
      '</div>' +
      '</div>';
  }
  function markerEditorHtml(m) {
    return '<div class="sec">' +
      '<h3>Маркер</h3>' +
      '<label>Внутреннее имя (автор)</label><input type="text" id="m_name" value="' + esc(m.name || '') + '">' +
      '<label>Видно игрокам</label><input type="text" id="m_vname" value="' + esc(m.visibleName || '') + '">' +
      '<div class="row">' +
      '<div><label>Тип</label><select id="m_type">' +
      ['location', 'faction', 'danger', 'secret', 'hub'].map(function (t) {
        return '<option value="' + t + '" ' + (m.type === t ? 'selected' : '') + '>' + TYPE_LABEL[t] + '</option>';
      }).join('') +
      '</select></div>' +
      '<div><label>Зона</label><select id="m_zone"><option value="">—</option>' +
      zones.map(function (z) { return '<option value="' + z.id + '" ' + (m.zone === z.id ? 'selected' : '') + '>' + esc(z.name) + '</option>'; }).join('') +
      '</select></div>' +
      '</div>' +
      '<label>Статус</label>' + statusButtonsHtml(m) +
      '<label>Текст для игроков</label><textarea id="m_ptext">' + esc(m.playerText || '') + '</textarea>' +
      '<label>Заметки автора (GM · шифруется)</label><textarea id="m_gtext" disabled placeholder="расшифровка…"></textarea>' +
      '<div class="btnrow"><button class="btn warn" id="m_del">Удалить</button></div>' +
      '</div>';
  }
  function renderPanel() {
    var side = $('#side');
    if (!side) return;
    if (!window.DKGM.isUnlocked()) { side.classList.add('hidden'); side.innerHTML = ''; return; }
    side.classList.remove('hidden');
    var html = '<div class="sec">' +
      '<h3>Инструменты автора</h3>' +
      '<div class="btnrow">' +
      '<button class="btn gold" id="drawZoneBtn">' + (drawing ? 'Завершить зону (Enter)' : 'Рисовать зону') + '</button>' +
      '<button class="btn" id="addMarkerBtn">' + (placingMarker ? '…клик по карте' : '+ Маркер') + '</button>' +
      '</div>' +
      '<p class="muted">Зона: «Рисовать зону» → клики по углам → «Завершить»/Enter. Маркер: «+ Маркер» → клик. Esc — отмена.</p>' +
      '<div class="legend">' + legendHtml() + '</div>' +
      '<p class="muted">Зон: ' + zones.length + ' · маркеров: ' + markers.length + '. Правки сохраняются локально; «Данные ▾» → экспорт для коммита.</p>' +
      '</div>';
    if (conflict) html += conflictBannerHtml();
    if (sel && sel.kind === 'zone') {
      var z = zones.find(function (x) { return x.id === sel.id; });
      if (z) html += zoneEditorHtml(z);
    } else if (sel && sel.kind === 'marker') {
      var m = markers.find(function (x) { return x.id === sel.id; });
      if (m) html += markerEditorHtml(m);
    } else {
      html += '<div class="sec"><p class="muted">Выбери зону или маркер на карте, чтобы редактировать.</p></div>';
    }
    side.innerHTML = html;
    wireSide();
  }
  // Не вызывает renderPanel() на каждый ввод — иначе textarea/input теряют фокус и
  // позицию курсора на каждой нажатой клавише (та же дисциплина, что в app.js bindInput).
  function bindInput(id, fn, rerenderLayers) {
    var el = document.getElementById(id); if (!el) return;
    el.addEventListener('input', function () {
      fn(el.value); saveDraft();
      if (rerenderLayers) { renderZonesLayer(); renderMarkersLayer(); }
    });
  }
  function bindSelect(id, fn) {
    var el = document.getElementById(id); if (!el) return;
    el.addEventListener('change', function () { fn(el.value); saveDraft(); });
  }
  function bindStatus(obj) {
    document.querySelectorAll('#side .statusgrid button').forEach(function (b) {
      b.onclick = function () {
        obj.status = b.dataset.status;
        saveDraft();
        if (obj.polygon) window.DKFog.syncZone(obj);
        renderZonesLayer(); renderMarkersLayer(); renderPanel();
      };
    });
  }
  function bindGmField(id, kind, obj) {
    var el = document.getElementById(id); if (!el) return;
    decryptGmText(obj).then(function (plaintext) {
      el.disabled = false; el.placeholder = ''; el.value = plaintext;
      el.addEventListener('input', function () { scheduleGmSave(kind, obj, el.value); });
    }).catch(function (e) {
      el.disabled = false; el.value = '';
      el.placeholder = 'Не удалось расшифровать (устаревший черновик?) — новый ввод перезапишет.';
      console.error('editor-engine: decrypt gmText failed', e);
      el.addEventListener('input', function () { scheduleGmSave(kind, obj, el.value); });
    });
  }
  function wireSide() {
    var db = document.getElementById('drawZoneBtn'); if (db) db.onclick = toggleDrawZone;
    var am = document.getElementById('addMarkerBtn');
    if (am) am.onclick = function () { placingMarker = !placingMarker; renderPanel(); };
    var ck = document.getElementById('conflictKeep'); if (ck) ck.onclick = function () { conflict = false; renderPanel(); };
    var cr = document.getElementById('conflictReset');
    if (cr) cr.onclick = function () { if (confirm('Сбросить черновик и загрузить данные из репозитория?')) resetToRepo(); };

    if (sel && sel.kind === 'zone') {
      var z = zones.find(function (x) { return x.id === sel.id; }); if (!z) return;
      bindInput('z_name', function (v) { z.name = v; }, true);
      bindInput('z_band', function (v) { z.band = v; });
      bindInput('z_owner', function (v) { z.owner = v; });
      bindInput('z_ptext', function (v) { z.playerText = v; });
      bindGmField('z_gtext', 'zone', z);
      bindStatus(z);
      document.getElementById('z_redraw').onclick = function () {
        drawing = { points: [], redraw: true, id: z.id };
        renderDrawPreview();
        toast('Кликай углы, Enter — готово');
        renderPanel();
      };
      document.getElementById('z_del').onclick = function () {
        if (!confirm('Удалить зону?')) return;
        zones = zones.filter(function (x) { return x.id !== z.id; });
        window.DKFog.removeZone(z.id);
        sel = null; saveDraft();
        renderZonesLayer(); renderMarkersLayer(); renderPanel();
        toast('Зона удалена');
      };
    } else if (sel && sel.kind === 'marker') {
      var m = markers.find(function (x) { return x.id === sel.id; }); if (!m) return;
      bindInput('m_name', function (v) { m.name = v; }, true);
      bindInput('m_vname', function (v) { m.visibleName = v; }, true);
      bindInput('m_ptext', function (v) { m.playerText = v; });
      bindGmField('m_gtext', 'marker', m);
      bindSelect('m_type', function (v) { m.type = v; renderMarkersLayer(); });
      bindSelect('m_zone', function (v) { m.zone = v; });
      bindStatus(m);
      document.getElementById('m_del').onclick = function () {
        if (!confirm('Удалить маркер?')) return;
        markers = markers.filter(function (x) { return x.id !== m.id; });
        sel = null; saveDraft();
        renderZonesLayer(); renderMarkersLayer(); renderPanel();
        toast('Маркер удалён');
      };
    }
  }

  /* ---------- экспорт (данные уже несут корректно зашифрованный gmText — шифруем при
     сохранении, не при экспорте, см. решение по спорному 1; повторного прохода не нужно) ---------- */
  function wrapDoc(items) { return { schema: 'dk-map/v3', mapOrientation: 'v3', items: items }; }
  function download(name, content) {
    var b = new Blob([content], { type: 'application/json' });
    var u = URL.createObjectURL(b);
    var a = document.createElement('a'); a.href = u; a.download = name; a.click();
    setTimeout(function () { URL.revokeObjectURL(u); }, 1500);
  }
  function doExport(which) {
    var items = which === 'zones' ? zones : markers;
    var doc = wrapDoc(items);
    var s = JSON.stringify(doc, null, 2).replace(/\[\s+(-?[\d.eE]+),\s+(-?[\d.eE]+)\s+\]/g, '[$1, $2]');
    download(which + '.json', s);
    toast(which + '.json экспортирован');
  }

  /* ---------- toast (переиспользует #toast) ---------- */
  var toastT = null;
  function toast(msg) {
    var t = $('#toast'); if (!t) return;
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }

  /* ---------- меню «Данные» (переиспользует #menuBtn/#menuModal из index.html — то же,
     что gm-engine.js делает с #masterBtn/#masterModal). #menuBtn виден через уже
     существующее правило body.edit .edit-only (см. css/style.css) — переключаем body.edit,
     не изобретаем новый механизм видимости. */
  function wireMenu() {
    var menuBtn = $('#menuBtn'), menuModal = $('#menuModal');
    if (!menuBtn || !menuModal) { console.error('editor-engine: #menuBtn/#menuModal не найдены'); return; }
    menuBtn.addEventListener('click', function () { menuModal.classList.add('show'); });
    $('#menuClose').addEventListener('click', function () { menuModal.classList.remove('show'); });
    $('#exportZones').addEventListener('click', function () { doExport('zones'); });
    $('#exportMarkers').addEventListener('click', function () { doExport('markers'); });
    $('#resetWork').addEventListener('click', function () {
      if (!confirm('Сбросить локальные правки и загрузить данные из репозитория?')) return;
      resetToRepo();
      menuModal.classList.remove('show');
    });
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && menuModal.classList.contains('show')) menuModal.classList.remove('show');
    });
  }

  /* ---------- Enter/Esc — рисование зоны / размещение маркера (порт 1:1 из app.js) ---------- */
  window.addEventListener('keydown', function (e) {
    if (!window.DKGM.isUnlocked()) return;
    if (e.key === 'Enter' && drawing) finishZone();
    if (e.key === 'Escape' && (drawing || placingMarker)) cancelDraw();
  });

  /* ---------- вкл/выкл по факту unlock/lock (window.DKGM.onChange) ---------- */
  function enable() {
    loadData().then(function () {
      window.DKMarkers.setEnabled(false); // прячем read-слой — этот модуль показывает свой (все объекты, кликабельны)
      document.body.classList.add('edit'); // #menuBtn виден (см. wireMenu)
      // группы монтируются на карту ДО рендера содержимого: L.Marker.getElement() (нужен
      // для data-marker-id) отдаёт DOM-узел только после реального рендера, а он у
      // LayerGroup происходит только когда сама группа уже на карте (см. тот же фикс
      // в js/markers-engine.js).
      if (!DK.map.hasLayer(zoneLayerGroup)) zoneLayerGroup.addTo(DK.map);
      if (!DK.map.hasLayer(markerLayerGroup)) markerLayerGroup.addTo(DK.map);
      renderZonesLayer(); renderMarkersLayer();
      renderPanel();
    }).catch(function (e) { console.error('editor-engine: не удалось загрузить данные', e); });
  }
  function disable() {
    cancelDraw();
    sel = null;
    zoneLayerGroup.clearLayers(); if (DK.map.hasLayer(zoneLayerGroup)) zoneLayerGroup.remove();
    markerLayerGroup.clearLayers(); if (DK.map.hasLayer(markerLayerGroup)) markerLayerGroup.remove();
    window.DKMarkers.setEnabled(true); // Дымка (решение 2) остаётся как есть — не гасим и не восстанавливаем
    document.body.classList.remove('edit');
    renderPanel();
  }

  wireMenu();
  window.DKGM.onChange(function (unlocked) { if (unlocked) enable(); else disable(); });

  // Экспорт для тестов — состояние без хардкода id/текстов (см. tests/editor.spec.js).
  window.DKEditor = {
    getZones: function () { return zones.slice(); },
    getMarkers: function () { return markers.slice(); },
    hasConflict: function () { return conflict; },
  };
})();
