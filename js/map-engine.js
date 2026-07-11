// Ф3.1/Ф3.5в: тайл-слой Leaflet поверх пирамиды tiles (tiles_v3, квадратный русский
// мастер-растр). Единственное место преобразования координат норм.<->latLng —
// см. normToLatLng/latLngToNorm.
//
// Ф3.5в: мир квадратный (мастер v3 — 1:1) — одна константа MASTER_SIZE вместо
// раздельных IMG_W/IMG_H книжного v2-разворота (3300x5100). NATIVE_Z и maxZoom
// выведены формулой из MASTER_SIZE, а не захардкожены раздельно.
//
// РЕШЕНИЕ ИВАНА (вариант б2, отчёт Ф3.5в фаза Б): MASTER_SIZE=5000, НЕ 10000 —
// честная z6-сетка (нативное разрешение полного 10000x10000 AI-апскейленного
// мастера) роняла кадры при hop сверх перф-бюджета, см. подробное расследование
// в комментарии у tileLayer ниже. Компромисс: тайлы 0-5 (даунскейл AI-мастера,
// максимум честный z5) плюс OVERZOOM_LEVELS=3 — тот же зум-потолок 8, что давал бы
// честный z6, только последний шаг CSS-интерполяцией вместо нативных пикселей
// (измеренная, небольшая визуальная цена — кропы в отчёте).
//
// Задел на будущее: полный 10000x10000 мастер и честная z6-пирамида (1600 тайлов)
// сохранены в maphost (drakkenheim_city_map_master_v3.png, tiles_v3_z6/), не
// деплоятся. Включение = поднять MASTER_SIZE обратно до 10000 здесь + вернуть
// OVERZOOM_LEVELS на 2 + задеплоить tiles_v3_z6/6 как tiles_v3/6 — см. maphost/README.
(function () {
  var MASTER_SIZE = 5000;
  var IMG_W = MASTER_SIZE, IMG_H = MASTER_SIZE;
  // NATIVE_Z: наименьший zoom, где тайл-сетка (256px/тайл) целиком покрывает мастер.
  var NATIVE_Z = Math.ceil(Math.log2(MASTER_SIZE / 256));
  var OVERZOOM_LEVELS = 3; // б2: тот же зум-потолок (NATIVE_Z+3=8), что дал бы честный z6
  var MAX_ZOOM = NATIVE_Z + OVERZOOM_LEVELS;

  var map = L.map('map', {
    crs: L.CRS.Simple,
    minZoom: 0,
    maxZoom: MAX_ZOOM,
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

  // Ф3.5в перф-расследование (полный отчёт Ивану, все попытки и числа): честная
  // z6-сетка (нативное разрешение 10000x10000 AI-апскейленного мастера) роняла
  // кадры при hop (быстрый flyTo через несколько зумов) сверх бюджета 1.25x
  // (прод ~32-38% dropped против стенда ~7-9%). Испробовано и отклонено:
  //  - 3 ручки порядка/момента загрузки тайлов (updateWhenZooming/Idle, keepBuffer,
  //    переходный слой по порогу зума) — без толку или хуже;
  //  - отключение fog-слоя целиком — без толку (не туман);
  //  - TILE_SIZE 256->512 (вчетверо меньше fetch/decode/upload-операций на z6,
  //    20x20=400 вместо 40x40=1600) — тоже без толку (~40% dropped, не лучше 256px).
  // CDP-трейс: весь прирост в CrGpuMain/GPUTask GPU-процесса (×2.17), JS/layout/paint
  // на CrRendererMain даже легче. 512px опроверг гипотезу "дело в количестве
  // операций" — раз меньше операций не помогло, это цена большего визуального
  // объёма/детализации на том же зуме, не настраиваемый параметр тайлинга.
  // Решение — MASTER_SIZE=5000 выше (вариант б2): 8.96%/4.46% dropped в замерах,
  // чисто в бюджете. TILE_SIZE остаётся 256 — эксперимент с 512 не дал выигрыша.
  var TILE_SIZE = 256;
  L.tileLayer('tiles/{z}/{x}/{y}.png', {
    tileSize: TILE_SIZE,
    minNativeZoom: 0,
    maxNativeZoom: NATIVE_Z,
    maxZoom: MAX_ZOOM,
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

  // Экспорт для других модулей движка (напр. fog-engine.js), чтобы они не заводили
  // собственных преобразований координат/размеров карты.
  window.DKMapEngine = {
    map: map,
    normToLatLng: normToLatLng,
    latLngToNorm: latLngToNorm,
    bounds: bounds,
    IMG_W: IMG_W,
    IMG_H: IMG_H,
    MASTER_SIZE: MASTER_SIZE,
    NATIVE_Z: NATIVE_Z,
    MAX_ZOOM: MAX_ZOOM,
    TILE_SIZE: TILE_SIZE
  };
})();
