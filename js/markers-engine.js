// Ф3.4: слой маркеров для Leaflet-движка (?engine=leaflet), реальные данные
// из data/v2/markers.json. Только эта ветка бутстрапа — app.js (v1) не трогается.
//
// Видимость — та же логика, что в v1 (app.js renderMarkers): маркер скрыт, если
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

  Promise.all([
    fetch('data/v2/markers.json', {cache: 'no-store'}).then(function (r) {
      return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status));
    }),
    fetch('data/v2/zones.json', {cache: 'no-store'}).then(function (r) {
      return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status));
    })
  ]).then(function (results) {
    var markers = (results[0] && results[0].items) || [];
    var zones = (results[1] && results[1].items) || [];
    var zoneById = {};
    zones.forEach(function (z) { zoneById[z.id] = z; });

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

      var marker = L.marker(DK.normToLatLng(m.x, m.y), {icon: icon, keyboard: false}).addTo(DK.map);

      var title = m.visibleName || m.name || '';
      var band = TYPE_LABEL[m.type] || '';
      var popupHtml = '<div class="dk-marker-pop">' +
        (band ? '<div class="dk-marker-pop-band">' + band + '</div>' : '') +
        '<h3>' + title + '</h3>' +
        (m.playerText ? '<p>' + m.playerText + '</p>' : '') +
        '</div>';
      marker.bindPopup(popupHtml);

      var el = marker.getElement();
      if (el) el.setAttribute('data-marker-id', m.id);

      shown++;
    });

    console.log('markers-engine: ' + shown + '/' + markers.length + ' маркеров показано (data/v2/markers.json)');
  }).catch(function (err) {
    console.error('markers-engine: не удалось загрузить данные', err);
  });
})();
