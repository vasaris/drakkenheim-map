// Ф3.4/Ф3.5в: слой маркеров Leaflet-движка, реальные данные из data/v3/markers.json.
//
// Видимость — та же логика, что была в v1 (app.js renderMarkers, снесён в Ф3.6): маркер скрыт, если
// его status === "hidden", ИЛИ если он привязан к зоне (m.zone) и та зона тоже
// status === "hidden". gmText НЕ читается и никуда не выводится — это Ф3.5.
(function () {
  var DK = window.DKMapEngine;
  if (!DK) {
    console.error('markers-engine: window.DKMapEngine не найден — map-engine.js должен грузиться раньше');
    return;
  }

  var MARKER_COLOR = {location: '#c9a85f', faction: '#5b76b8', danger: '#c5453f', secret: '#b06ae0', hub: '#5fae74'};
  var TYPE_LABEL = {location: 'Локация', faction: 'Фракция', danger: 'Опасность', secret: 'Секрет', hub: 'Хаб'};

  // Ф3.5б: маркеры этого read-слоя (playerText-попапы, скрывает hidden) собраны в
  // отдельную LayerGroup — js/editor-engine.js прячет её на время авторского режима
  // (свой слой показывает ВСЕ маркеры кликабельными-для-выбора вместо попапов) и
  // возвращает при разлочке. window.DKMarkers доступен синхронно (readLayer заведён
  // сразу), даже если сами маркеры ещё не подгрузились — setEnabled просто no-op на
  // пустой группе до этого момента.
  var readLayer = L.layerGroup();
  window.DKMarkers = {
    setEnabled: function (enabled) {
      if (enabled) { if (!DK.map.hasLayer(readLayer)) readLayer.addTo(DK.map); }
      else { if (DK.map.hasLayer(readLayer)) readLayer.remove(); }
    },
  };

  function esc(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Ф3.5а-фикс #2: попап собирается ЗАНОВО при каждом открытии (bindPopup принимает функцию —
  // см. Leaflet docs), а не один раз при создании маркера — иначе разлочка GM после того, как
  // маркер уже создан, не отразилась бы в уже забинженной строке. window.DKGM — экспорт
  // gm-engine.js (грузится параллельно; к моменту клика по маркеру он уже готов).
  //
  // Ф3.6: этот GM-блок недостижим при текущей модели (разлочка=редактор — editor-engine.js
  // прячет readLayer целиком на время unlock, см. DKMarkers.setEnabled, поэтому попап с этим
  // блоком никогда не показывается разлоченному GM). Оставлен как есть — оживёт вместе с
  // отдельным GM-read-режимом (бэклог); тест tests/gm.spec.js (d) держит барьер "до разлочки
  // GM-блока в попапе нет".
  function popupHtml(m) {
    var title = m.visibleName || m.name || '';
    var band = TYPE_LABEL[m.type] || '';
    var html = '<div class="dk-marker-pop">' +
      (band ? '<div class="dk-marker-pop-band">' + band + '</div>' : '') +
      '<h3>' + title + '</h3>' +
      (m.playerText ? '<p>' + m.playerText + '</p>' : '');
    if (window.DKGM && window.DKGM.isUnlocked()) {
      var gmText = window.DKGM.getPlain('marker', m.id);
      html += '<div class="dk-marker-pop-gm"><label>GM</label><p class="gmnote">' +
        (gmText ? esc(gmText) : '<span class="muted">— пусто —</span>') + '</p></div>';
    }
    html += '</div>';
    return html;
  }

  Promise.all([
    fetch('data/v3/markers.json', {cache: 'no-store'}).then(function (r) {
      return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status));
    }),
    fetch('data/v3/zones.json', {cache: 'no-store'}).then(function (r) {
      return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status));
    })
  ]).then(function (results) {
    var markers = (results[0] && results[0].items) || [];
    var zones = (results[1] && results[1].items) || [];
    var zoneById = {};
    zones.forEach(function (z) { zoneById[z.id] = z; });

    // readLayer монтируется на карту ДО создания маркеров: L.Marker.getElement() отдаёт
    // DOM-узел только после реального рендера, а LayerGroup рендерит своих детей только
    // когда сама уже на карте — иначе data-marker-id (на нём завязаны тесты) не проставится.
    readLayer.addTo(DK.map);

    var shown = 0;
    markers.forEach(function (m) {
      if (m.status === 'hidden') return;
      var zone = m.zone && zoneById[m.zone];
      if (zone && zone.status === 'hidden') return;

      var icon = L.divIcon({
        className: 'dk-marker dk-marker-' + (m.type || 'location'),
        html: '<span class="dk-marker-dot" style="background:' + (MARKER_COLOR[m.type] || MARKER_COLOR.location) + '"></span>',
        iconSize: [16, 16],
        iconAnchor: [8, 8]
      });

      var marker = L.marker(DK.normToLatLng(m.x, m.y), {icon: icon, keyboard: false});

      marker.bindPopup(function () { return popupHtml(m); });

      // Ф3.5б: readLayer теперь снимается с карты и возвращается (editor-engine.js
      // прячет этот слой на время авторского режима) — Leaflet при повторном addTo()
      // отрисовывает icon заново, и атрибут, выставленный один раз при создании,
      // терялся бы. Перевешиваем на каждое реальное добавление в DOM, не только на первое.
      marker.on('add', function () {
        var el = marker.getElement();
        if (el) el.setAttribute('data-marker-id', m.id);
      });
      marker.addTo(readLayer);

      shown++;
    });

    console.log('markers-engine: ' + shown + '/' + markers.length + ' маркеров показано (data/v3/markers.json)');
  }).catch(function (err) {
    console.error('markers-engine: не удалось загрузить данные', err);
  });
})();
