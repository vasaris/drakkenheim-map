// Ф3.1: тайл-слой Leaflet поверх пирамиды tiles_v2 (книжный разворот).
// Единственное место преобразования координат норм.<->latLng — см. normToLatLng/latLngToNorm.
(function () {
  var IMG_W = 3300, IMG_H = 5100, NATIVE_Z = 5;

  var map = L.map('map', {
    crs: L.CRS.Simple,
    minZoom: 0,
    maxZoom: 7,
    zoomSnap: 0.25,
    zoomDelta: 0.25,
    attributionControl: false
  });

  function normToLatLng(nx, ny) {
    return map.unproject([nx * IMG_W, ny * IMG_H], NATIVE_Z);
  }
  function latLngToNorm(ll) {
    var p = map.project(ll, NATIVE_Z);
    return [p.x / IMG_W, p.y / IMG_H];
  }

  var bounds = L.latLngBounds(
    map.unproject([0, 0], NATIVE_Z),
    map.unproject([IMG_W, IMG_H], NATIVE_Z)
  );

  L.tileLayer('tiles/{z}/{x}/{y}.png', {
    tileSize: 256,
    minNativeZoom: 0,
    maxNativeZoom: 5,
    maxZoom: 7,
    noWrap: true,
    bounds: bounds
  }).addTo(map);

  map.setMaxBounds(bounds.pad(0.1));
  map.fitBounds(bounds);

  var rt = latLngToNorm(normToLatLng(0.5, 0.5));
  var ok = Math.abs(rt[0] - 0.5) < 1e-9 && Math.abs(rt[1] - 0.5) < 1e-9;
  if (!ok) {
    console.error('map-engine: round-trip sanity FAILED', rt);
  } else {
    console.log('map-engine: round-trip sanity OK', rt);
  }

  // Экспорт для других модулей ветки ?engine=leaflet (напр. fog-engine.js), чтобы
  // они не заводили собственных преобразований координат/размеров карты.
  window.DKMapEngine = {
    map: map,
    normToLatLng: normToLatLng,
    latLngToNorm: latLngToNorm,
    bounds: bounds,
    IMG_W: IMG_W,
    IMG_H: IMG_H,
    NATIVE_Z: NATIVE_Z
  };
})();
