// Ф3.3-Т: детерминированные проверки Leaflet fog-engine. Headless — ок, ничего из этого
// не измеряет FPS (см. perf.spec.js для этого, отдельно и headed).
//
// Архитектурный принцип (обязателен для всех тестов в этом файле, см. п. (f) ТЗ):
// ожидания берутся из window.DKMapEngine (IMG_W/IMG_H/map/normToLatLng/...) и из
// текущей DOM-геометрии вырезов тумана, а не из хардкод-чисел/id зон. Ф3.4 меняет
// данные (тестовые вырезы → реальные зоны) — эти тесты обязаны пережить миграцию
// без правок.

const { test, expect } = require('@playwright/test');

// Ф3.6: v1 снесён — скоуп на весь document, вердикт B требует нулевого feTurbulence
// во всём DOM.
const FOG_SCOPE = process.env.FOG_SCOPE || 'document';

test.describe('correctness: Ф3.3 fog-engine', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { waitUntil: 'load' });
    await page.waitForFunction(() => !!(window.DKMapEngine && window.DKMapEngine.map));
  });

  test('a) DKMapEngine создан, round-trip sanity OK в консоли, тайлы без 404', async ({ page }) => {
    // console/response слушатели навешаны ПОСЛЕ первого goto в beforeEach — навигируем
    // заново в этом тесте, чтобы гарантированно перехватить лог бутстрапа и запросы тайлов.
    const consoleTexts = [];
    page.on('console', (msg) => consoleTexts.push(msg.text()));
    const tileResponses = [];
    page.on('response', (res) => {
      if (/\/tiles\/\d+\/\d+\/\d+\.png$/.test(new URL(res.url()).pathname)) tileResponses.push(res);
    });

    await page.goto('/', { waitUntil: 'load' });
    await page.waitForFunction(() => !!(window.DKMapEngine && window.DKMapEngine.map));

    const dk = await page.evaluate(() => ({
      hasMap: !!window.DKMapEngine.map,
      hasNormToLatLng: typeof window.DKMapEngine.normToLatLng === 'function',
      hasLatLngToNorm: typeof window.DKMapEngine.latLngToNorm === 'function',
      IMG_W: window.DKMapEngine.IMG_W,
      IMG_H: window.DKMapEngine.IMG_H,
    }));
    expect(dk.hasMap).toBe(true);
    expect(dk.hasNormToLatLng).toBe(true);
    expect(dk.hasLatLngToNorm).toBe(true);
    expect(dk.IMG_W).toBeGreaterThan(0);
    expect(dk.IMG_H).toBeGreaterThan(0);

    expect(consoleTexts.some((t) => t.includes('map-engine: round-trip sanity OK'))).toBe(true);
    expect(consoleTexts.some((t) => t.includes('round-trip sanity FAILED'))).toBe(false);

    await expect.poll(() => tileResponses.length, { timeout: 5000, message: 'тайлы так и не запросились' })
      .toBeGreaterThan(0);
    const statuses = tileResponses.map((r) => r.status());
    expect(statuses.filter((s) => s === 404)).toHaveLength(0);
    expect(statuses.some((s) => s === 200)).toBe(true);
  });

  // Ф3.6-fix2в: туман войны (per-zone статусные вырезы) отменён — вместо позиционной
  // проверки вырезов теперь проверяем ПЛОТНОСТЬ вуали в конкретных точках. Рендер-тест
  // (не DOM/геометрия): клонируем живой SVG, ОБЯЗАТЕЛЬНО снимаем инлайн-style (Leaflet
  // проставляет свой width/height под текущий зум — если его не убрать, клон рендерится
  // в CSS-разрешении, а не в честных world-px, и все замеры плотности врут — поймано и
  // подробно описано в отчёте Ф3.6-fix2б), рисуем на чёрном фоне и берём канал R как
  // прокси плотности (fogRect — сплошной #5e4488, alpha от mask-luminance, на чёрном
  // фоне композит строго пропорционален alpha).
  async function sampleFogDensity(page, nx, ny) {
    return page.evaluate(({ nx, ny }) => {
      return new Promise((resolve, reject) => {
        const DKm = window.DKMapEngine;
        const liveSvg = document.querySelector('.leaflet-overlay-pane svg.leaf-fog-anim');
        const vb = liveSvg.viewBox.baseVal;
        const clone = liveSvg.cloneNode(true);
        clone.removeAttribute('style');
        clone.setAttribute('width', String(vb.width));
        clone.setAttribute('height', String(vb.height));
        const markup = new XMLSerializer().serializeToString(clone);
        const blob = new Blob([markup], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = vb.width;
          canvas.height = vb.height;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#000000';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          const rawX = nx * DKm.MASTER_SIZE, rawY = ny * DKm.MASTER_SIZE;
          const d = ctx.getImageData(rawX, rawY, 1, 1).data;
          URL.revokeObjectURL(url);
          resolve(d[0]); // R-канал fogColor(94,68,136) — монотонен по alpha, годится как прокси плотности
        };
        img.onerror = reject;
        img.src = url;
      });
    }, { nx, ny });
  }

  test('b) вуаль покрывает лист + плотность Deep Haze выше базовой (Парк, Кратер, обычная улица, лес, кромка)', async ({ page }) => {
    await page.waitForFunction(() => !!document.querySelector('.leaf-haze-crater, .leaf-haze-deep'));

    const points = {
      forest: [0.10, 0.50],       // глубокий лес/outskirts — вне haze.json
      regularStreet: [0.268, 0.461], // центр zones.json sprawl — городская зона БЕЗ Deep Haze
      edge: [0.02, 0.50],         // кромка листа — база обязана дотягивать и сюда
      queensPark: [0.4286, 0.3002], // центроид haze.json queens_park (kind=deep)
      crater: [0.6138, 0.4849],     // центроид haze.json crater (kind=crater)
    };

    const density = {};
    for (const [label, [nx, ny]] of Object.entries(points)) {
      density[label] = await sampleFogDensity(page, nx, ny);
    }

    // вуаль покрывает лист целиком — ни в лесу, ни на кромке нет дыр (плотность > 0)
    expect(density.forest, 'лес: вуаль должна покрывать (плотность > 0)').toBeGreaterThan(0);
    expect(density.edge, 'кромка листа: вуаль должна покрывать (плотность > 0)').toBeGreaterThan(0);

    // статусы зон от тумана отвязаны — обычная городская улица не гуще леса (тот же базовый слой)
    expect(Math.abs(density.regularStreet - density.forest), 'обычная улица должна быть на уровне базовой плотности, не гуще').toBeLessThanOrEqual(3);

    // Deep Haze заметно плотнее базового слоя
    expect(density.queensPark, 'Парк Королевы обязан быть плотнее базовой Дымки').toBeGreaterThan(density.forest + 20);

    // kind=crater — максимальная плотность, гуще обычного Deep Haze
    expect(density.crater, 'Кратер обязан быть плотнее Парка (kind=crater — максимум)').toBeGreaterThan(density.queensPark);
  });

  test(`c) в DOM нет feTurbulence в пределах ${FOG_SCOPE}`, async ({ page }) => {
    const count = await page.evaluate((scope) => document.querySelectorAll(`${scope} svg feTurbulence`).length, FOG_SCOPE);
    expect(count).toBe(0);
  });

  // Ф3.6-fix2в: тест (d) «reveal: transition ~1.1s на вырезах тумана» удалён — вместе
  // с per-zone статусными вырезами исчез и сам reveal (смена fill зоны в рантайме).
  // Deep Haze грузится один раз из haze.json и не меняется в рантайме — animировать
  // на смену уже нечего (см. комментарий в js/fog-engine.js).
});
