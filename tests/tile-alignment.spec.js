// Ф3.6-fix2: новый класс регрессии — «контент тайла совпадает с математикой мира».
//
// Инцидент (ре-приёмка Ф3.6-fix отклонена, два факта): (1) рваные полосы на листе
// остались — оказались границей кольца outskirts, не рендер-багом (см. golden/данные,
// point-in-poly разбор в отчёте); (2) WORLD_PX-подложка тумана легла «плитой» за
// пределами листа на зуме-ауте — визуальная регрессия, фикс откачен (см. git revert).
//
// При разборе (2) всплыл РЕАЛЬНЫЙ, но отдельный от (1) факт: тайл z0 (единственный на
// этом зуме — вся пирамида ceil-округляет число тайлов НЕЗАВИСИМО на каждом уровне)
// отдаёт 100% мастера без паддинга (честный даунскейл 5000×5000 -> 256×256, ничего не
// обрезано), тогда как z1/z2/z5 честно паддятся ЧЁРНЫМ за пределами MASTER_SIZE. Модель
// Leaflet CRS.Simple (scale(zoom)=2^zoom, единая NATIVE_Z=5 точка отсчёта) требует,
// чтобы КАЖДЫЙ зум одинаково укладывался в эту формулу — а z0 в неё не укладывается
// (его контент фактически представляет [0, MASTER_SIZE], но Leaflet кладёт его на
// экран так, будто это [0, TILE_SIZE*2^NATIVE_Z]). Глазами это ловится только на
// экстремальном зуме-аут — этот тест ловит численно, на любом зуме из списка, чтобы
// правка тайлера/пирамиды (или её отсутствие) была видна в прогоне, а не в проде.
//
// Метод: для последнего тайла в ряду (индекс = ceil(MASTER_SIZE/(TILE_SIZE*2^(NATIVE_Z-z)))-1)
// на каждом зуме — пиксель-проба по X, где кончается реальный контент и начинается
// чёрный паддинг тайлера (проверено вручную: паддинг — чистый (0,0,0), см. отчёт),
// сравнить с тем, где граница ДОЛЖНА быть по формуле мира (MASTER_SIZE, приведённый к
// пиксельному масштабу этого зума, минус смещение предыдущих тайлов).

const { test, expect } = require('@playwright/test');

const TILE_SIZE = 256;
const MASTER_SIZE = 5000;
const NATIVE_Z = 5;

function tilesPerSide(z) {
  return Math.ceil(MASTER_SIZE / (TILE_SIZE * Math.pow(2, NATIVE_Z - z)));
}

// Позиция границы контента внутри ПОСЛЕДНЕГО тайла ряда, в его собственных пикселях
// (0..TILE_SIZE). MASTER_SIZE, приведённый к пиксельному масштабу зума z, минус то,
// что уже покрыли предыдущие (не последние) тайлы этого ряда.
function expectedContentEdgeInLastTile(z) {
  var contentPxAtThisZoom = MASTER_SIZE / Math.pow(2, NATIVE_Z - z);
  var lastTileIndex = tilesPerSide(z) - 1;
  return contentPxAtThisZoom - lastTileIndex * TILE_SIZE;
}

// Пиксель-проба одного тайла в браузере (canvas + getImageData — не тянем отдельный
// PNG-декодер в node_modules). Возвращает, в тайл-локальных пикселях, координату X/Y
// последнего НЕ-паддингового столбца/строки (паддинг — чистый чёрный (0,0,0), см.
// отчёт Ф3.6-fix2: измерено на z1/z2/z5 last-тайлах, tolerance ниже сознательно узкий).
async function probeTileContentEdge(page, url) {
  return page.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('image failed to load: ' + src));
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const { width, height, data } = ctx.getImageData(0, 0, canvas.width, canvas.height);

    const BLACK_TOL = 6; // паддинг измерен как чистый (0,0,0); мелкий люфт на PNG-компрессию

    function colIsPadding(x) {
      for (let y = 0; y < height; y++) {
        const i = (y * width + x) * 4;
        if (data[i] > BLACK_TOL || data[i + 1] > BLACK_TOL || data[i + 2] > BLACK_TOL) return false;
      }
      return true;
    }
    function rowIsPadding(y) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (data[i] > BLACK_TOL || data[i + 1] > BLACK_TOL || data[i + 2] > BLACK_TOL) return false;
      }
      return true;
    }

    let lastContentCol = width - 1;
    while (lastContentCol >= 0 && colIsPadding(lastContentCol)) lastContentCol--;
    let lastContentRow = height - 1;
    while (lastContentRow >= 0 && rowIsPadding(lastContentRow)) lastContentRow--;

    return { width, height, lastContentCol, lastContentRow };
  }, url);
}

test.describe('tile alignment: контент тайла совпадает с математикой мира (Ф3.6-fix2)', () => {
  for (const z of [0, 1, 2, 5]) {
    test(`z${z}: граница контента в последнем тайле ряда/столбца vs unproject(MASTER_SIZE)`, async ({ page }) => {
      // z0 — известный, ИЗМЕРЕННЫЙ разъезд (см. отчёт Ф3.6-fix2): единственный тайл на
      // этом зуме содержит 100% мастера без паддинга (честный даунскейл 5000x5000 ->
      // 256x256), а не только долю MASTER_SIZE/(TILE_SIZE*2^NATIVE_Z), которую требует
      // формула CRS.Simple. xfail — не прячем баг, а документируем: тест обязан упасть,
      // пока пирамида не перегенерирована (или решение принято иначе); если он вдруг
      // начнёт ЗЕЛЕНЕТЬ без правки тайлера — это тоже сигнал, разбираться отдельно.
      if (z === 0) test.fail();

      await page.goto('/', { waitUntil: 'load' });

      const n = tilesPerSide(z);
      const lastIdx = n - 1;
      const url = `/tiles/${z}/${lastIdx}/${lastIdx}.png`;
      const expected = expectedContentEdgeInLastTile(z);

      const probe = await probeTileContentEdge(page, url);

      // expected — координата ПОСЛЕДНЕГО контентного пикселя (0-based) в тайл-локальных
      // координатах; если контент заполняет тайл целиком (expected >= TILE_SIZE), граница
      // паддинга не существует — ждём lastContentCol/Row == TILE_SIZE-1 (весь тайл контент).
      const expectedLastPx = Math.min(Math.round(expected) - 1, TILE_SIZE - 1);

      const label = `z${z} last-tile(${lastIdx},${lastIdx}) X: measured=${probe.lastContentCol} expected=${expectedLastPx} (мир MASTER_SIZE=${MASTER_SIZE} -> ${expected.toFixed(1)}px в тайле ${TILE_SIZE}px)`;
      console.log(label);

      expect(probe.lastContentCol, `${label} — расхождение = баг класса Ф3.6-fix2 (тайл не совпадает с математикой мира)`)
        .toBeGreaterThanOrEqual(expectedLastPx - 2);
      expect(probe.lastContentCol, label).toBeLessThanOrEqual(expectedLastPx + 2);

      expect(probe.lastContentRow, label.replace(' X:', ' Y:'))
        .toBeGreaterThanOrEqual(expectedLastPx - 2);
      expect(probe.lastContentRow, label.replace(' X:', ' Y:')).toBeLessThanOrEqual(expectedLastPx + 2);
    });
  }
});
