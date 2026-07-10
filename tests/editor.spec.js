// Ф3.5б: E2E авторского режима (js/editor-engine.js, ?engine=leaflet). Каждый test()
// получает свежий browser context (изолированный localStorage) — черновики между
// тестами не текут. Фикстуры — те же, что у gm-engine.js (tests/fixtures/gm-{fixture,
// empty}-*.json через ?gmfixture=...), отдельных editor-* фикстур не заводим (формат
// v2-документа один и тот же для обеих целей — см. план Ф3.5б, фаза А).
//
// Клики по карте — строго с x>340 (ширина #side, см. css/style.css .side{width:340px}):
// иначе клик перехватывает сама панель (она выше по z-index, см. tests/gm.spec.js
// assertVisiblyAboveLeaflet) и до карты не долетает — это уже один раз стоило мне
// сломанного диагностического прогона при разработке, держим тут явно в уме.

const { test, expect } = require('@playwright/test');
const fs = require('fs');
// lifecycle-фикстура (tests/fixtures/lifecycle-{zones,markers}.json) генерируется
// автоматически в tests/global-setup.js перед каждым прогоном — пароль оттуда же,
// единый источник, чтобы тест и генератор не разошлись по значению.
const { LIFECYCLE_PW } = require('./global-setup.js');

async function unlockSetup(page, pw) {
  await page.click('#masterBtn');
  await page.fill('#masterPw', pw);
  if (await page.isVisible('#masterPwConfirm')) await page.fill('#masterPwConfirm', pw);
  await page.click('#masterOk');
  await page.waitForFunction(() => window.DKGM.isUnlocked());
}

// Норм-координата -> экранный пиксель, через тот же DKMapEngine, которым живёт сама
// карта (см. tests/golden.spec.js тест 9 — тот же приём). Нужен сценарию 13: реальные
// районы (outskirts — внешнее кольцо, остальные — плитка внутри него) покрывают ВЕСЬ
// печатный лист карты без существенных зазоров, поэтому "свободного" места внутри [0,1]
// для тестовой зоны просто нет — рисуем её за пределами печатного листа (x>1), в поле,
// куда карта всё ещё кликабельна (map.setMaxBounds с 10% паддингом, см. js/map-engine.js).
async function normToScreen(page, nx, ny) {
  return page.evaluate(({ nx, ny }) => {
    const DK = window.DKMapEngine;
    const ll = DK.normToLatLng(nx, ny);
    const cp = DK.map.latLngToContainerPoint(ll);
    const mapRect = document.getElementById('map').getBoundingClientRect();
    return { x: mapRect.left + cp.x, y: mapRect.top + cp.y };
  }, { nx, ny });
}

test.describe('E2E: авторский режим (Ф3.5б editor-engine.js)', () => {
  test('01) рисовать зону: 3+ клика → Enter → зона в черновике, счётчик +1', async ({ page }) => {
    await page.goto('/?engine=leaflet&gmfixture=empty', { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.DKEditor);
    await unlockSetup(page, 'e2e-editor-pw');

    const before = await page.evaluate(() => window.DKEditor.getZones().length);
    await page.click('#drawZoneBtn');
    for (const [x, y] of [[500, 300], [560, 300], [560, 360], [500, 360]]) {
      await page.mouse.click(x, y);
      await page.waitForTimeout(30);
    }
    await page.keyboard.press('Enter');
    await page.waitForTimeout(100);

    const after = await page.evaluate(() => window.DKEditor.getZones().length);
    expect(after).toBe(before + 1);
    await expect(page.locator('#side')).toContainText(`Зон: ${after}`);
    const draft = await page.evaluate(() => JSON.parse(localStorage.getItem('dk_work_v2')));
    expect(draft.zones.length).toBe(after);
  });

  test('02) Esc во время рисования — отмена, ничего не создано', async ({ page }) => {
    await page.goto('/?engine=leaflet&gmfixture=empty', { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.DKEditor);
    await unlockSetup(page, 'e2e-editor-pw');

    const before = await page.evaluate(() => window.DKEditor.getZones().length);
    await page.click('#drawZoneBtn');
    await page.mouse.click(500, 300);
    await page.mouse.click(560, 300);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(80);

    const after = await page.evaluate(() => window.DKEditor.getZones().length);
    expect(after).toBe(before);
    await expect(page.locator('#drawZoneBtn')).toHaveText('Рисовать зону');
    // черновик не заведён этим действием (cancelDraw не пишет localStorage)
    expect(await page.evaluate(() => localStorage.getItem('dk_work_v2'))).toBeNull();
  });

  test('03) < 3 точек на «Завершить» — рисование отменяется с тостом, не «висит»', async ({ page }) => {
    await page.goto('/?engine=leaflet&gmfixture=empty', { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.DKEditor);
    await unlockSetup(page, 'e2e-editor-pw');

    const before = await page.evaluate(() => window.DKEditor.getZones().length);
    await page.click('#drawZoneBtn');
    await page.mouse.click(500, 300);
    await page.mouse.click(560, 300); // только 2 точки
    await page.click('#drawZoneBtn'); // «Завершить зону»
    await expect(page.locator('#toast')).toHaveText(/нужно ≥3 точек/i);

    const after = await page.evaluate(() => window.DKEditor.getZones().length);
    expect(after).toBe(before); // зона не создана
    await expect(page.locator('#drawZoneBtn')).toHaveText('Рисовать зону'); // режим сброшен, не завис
  });

  test('04) перерисовать контур существующей зоны — новые точки заменяют старые, id/поля не меняются', async ({ page }) => {
    await page.goto('/?engine=leaflet&gmfixture=empty', { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.DKEditor);
    await unlockSetup(page, 'e2e-editor-pw');

    await page.waitForSelector('.dk-editor-zone');
    await page.click('.dk-editor-zone');
    await page.waitForSelector('#z_redraw');
    const before = await page.evaluate(() => window.DKEditor.getZones()[0]);

    await page.click('#z_redraw');
    for (const [x, y] of [[500, 500], [560, 500], [560, 560]]) {
      await page.mouse.click(x, y);
      await page.waitForTimeout(30);
    }
    await page.keyboard.press('Enter');
    await page.waitForTimeout(100);

    const after = await page.evaluate(() => window.DKEditor.getZones()[0]);
    expect(after.id).toBe(before.id);
    expect(after.name).toBe(before.name);
    expect(after.polygon.length).toBe(3);
    expect(after.polygon).not.toEqual(before.polygon);
  });

  test('05) + Маркер клик внутри существующего полигона зоны → marker.zone проставляется автоматически', async ({ page }) => {
    await page.goto('/?engine=leaflet&gmfixture=empty', { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.DKEditor);
    await unlockSetup(page, 'e2e-editor-pw');

    // рисуем свою зону с известными экранными координатами, чтобы точно попасть внутрь
    await page.click('#drawZoneBtn');
    for (const [x, y] of [[500, 300], [700, 300], [700, 450], [500, 450]]) {
      await page.mouse.click(x, y);
      await page.waitForTimeout(30);
    }
    await page.keyboard.press('Enter');
    await page.waitForTimeout(100);
    const newZoneId = await page.evaluate(() => window.DKEditor.getZones().slice(-1)[0].id);

    await page.click('#addMarkerBtn');
    await page.mouse.click(600, 375); // центр только что нарисованного прямоугольника
    await page.waitForTimeout(100);

    const lastMarker = await page.evaluate(() => window.DKEditor.getMarkers().slice(-1)[0]);
    expect(lastMarker.zone).toBe(newZoneId);
  });

  test('06) смена статуса зоны → немедленно видна в DOM тумана', async ({ page }) => {
    await page.goto('/?engine=leaflet&gmfixture=empty', { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.DKEditor);
    await unlockSetup(page, 'e2e-editor-pw');

    await page.waitForSelector('.dk-editor-zone');
    await page.click('.dk-editor-zone');
    await page.waitForSelector('.statusgrid');

    const zoneId = await page.evaluate(() => window.DKEditor.getZones()[0].id);
    // fx_empty_zone_1 стартует со статусом "known" (см. tests/fixtures/gm-empty-zones.json)
    await page.click('.statusgrid .sb-explored');
    await page.waitForTimeout(50);

    const fill = await page.evaluate((id) => {
      const el = document.querySelector(`#map svg .leaf-hazezone[data-zone="${id}"]`);
      return el ? el.getAttribute('fill') : null;
    }, zoneId);
    expect(fill).toBe('#000000'); // FOG_HEX.explored, см. js/fog-engine.js
    const status = await page.evaluate(() => window.DKEditor.getZones()[0].status);
    expect(status).toBe('explored');
  });

  test('07) правка «Заметки автора» → localStorage несёт валидный v2-блок с AAD=id, не plaintext', async ({ page }) => {
    await page.goto('/?engine=leaflet&gmfixture=empty', { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.DKEditor);
    await unlockSetup(page, 'e2e-editor-pw');

    await page.waitForSelector('.dk-editor-zone');
    await page.click('.dk-editor-zone');
    await page.waitForSelector('#z_gtext:not([disabled])');
    await page.fill('#z_gtext', 'секретный план на игру');
    await page.waitForTimeout(600); // debounce 400ms + запас

    const gmText = await page.evaluate(() => window.DKEditor.getZones()[0].gmText);
    expect(gmText.enc).toBe(true);
    expect(gmText.v).toBe(2);
    expect(typeof gmText.salt).toBe('string'); expect(gmText.salt.length).toBeGreaterThan(0);
    expect(typeof gmText.iv).toBe('string'); expect(gmText.iv.length).toBeGreaterThan(0);
    expect(typeof gmText.ct).toBe('string'); expect(gmText.ct.length).toBeGreaterThan(0);

    const lsGmText = await page.evaluate(() => JSON.parse(localStorage.getItem('dk_work_v2')).zones[0].gmText);
    expect(lsGmText).toEqual(gmText); // ровно то же самое — не отдельная несинхронная копия
  });

  test('08) round-trip: блок из localStorage расшифровывается тем же сессионным ключом', async ({ page }) => {
    await page.goto('/?engine=leaflet&gmfixture=empty', { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.DKEditor);
    await unlockSetup(page, 'e2e-editor-pw');

    await page.waitForSelector('.dk-editor-zone');
    await page.click('.dk-editor-zone');
    await page.waitForSelector('#z_gtext:not([disabled])');
    await page.fill('#z_gtext', 'round-trip проверка текста');
    await page.waitForTimeout(600);

    const plain = await page.evaluate(async () => {
      const zone = window.DKEditor.getZones()[0];
      const ks = window.DKGM.getKeyAndSalt();
      return DKCrypto.aesDecrypt(ks.key, zone.gmText, zone.id);
    });
    expect(plain).toBe('round-trip проверка текста');

    // подмена id (AAD) обязана уронить decrypt — тот же инвариант, что в tests/gm-crypto.spec.mjs
    const tamperRejected = await page.evaluate(async () => {
      const zone = window.DKEditor.getZones()[0];
      const ks = window.DKGM.getKeyAndSalt();
      try { await DKCrypto.aesDecrypt(ks.key, zone.gmText, zone.id + '-tampered'); return false; }
      catch (e) { return true; }
    });
    expect(tamperRejected).toBe(true);
  });

  test('09) удалить зону/маркер → пропадает с карты и из черновика, счётчик −1', async ({ page }) => {
    await page.goto('/?engine=leaflet&gmfixture=empty', { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.DKEditor);
    await unlockSetup(page, 'e2e-editor-pw');

    await page.waitForSelector('.dk-editor-zone');
    await page.click('.dk-editor-zone');
    await page.waitForSelector('#z_del');
    const beforeZones = await page.evaluate(() => window.DKEditor.getZones().length);

    page.once('dialog', (d) => d.accept());
    await page.click('#z_del');
    await page.waitForTimeout(80);

    const afterZones = await page.evaluate(() => window.DKEditor.getZones().length);
    expect(afterZones).toBe(beforeZones - 1);
    await expect(page.locator('.dk-editor-zone')).toHaveCount(0);
    const draft = await page.evaluate(() => JSON.parse(localStorage.getItem('dk_work_v2')));
    expect(draft.zones.length).toBe(afterZones);

    // маркер аналогично
    await page.waitForSelector('.dk-marker[data-marker-id]');
    const beforeMarkers = await page.evaluate(() => window.DKEditor.getMarkers().length);
    await page.click('.dk-marker[data-marker-id]');
    await page.waitForSelector('#m_del');
    page.once('dialog', (d) => d.accept());
    await page.click('#m_del');
    await page.waitForTimeout(80);
    const afterMarkers = await page.evaluate(() => window.DKEditor.getMarkers().length);
    expect(afterMarkers).toBe(beforeMarkers - 1);
  });

  test('10) экспорт zones.json — валидный v2-документ, gmText это enc-блоки, не plaintext', async ({ page }) => {
    await page.goto('/?engine=leaflet&gmfixture=empty', { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.DKEditor);
    await unlockSetup(page, 'e2e-editor-pw');

    // даём зоне секрет, чтобы в экспорте был хотя бы один непустой enc-блок
    await page.waitForSelector('.dk-editor-zone');
    await page.click('.dk-editor-zone');
    await page.waitForSelector('#z_gtext:not([disabled])');
    await page.fill('#z_gtext', 'экспортный секрет');
    await page.waitForTimeout(600);

    await page.click('#menuBtn');
    await page.waitForSelector('#menuModal.show');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#exportZones'),
    ]);
    const filePath = await download.path();
    const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    expect(doc.schema).toBe('dk-map/v2');
    expect(doc.mapOrientation).toBe('v2');
    expect(Array.isArray(doc.items)).toBe(true);
    const withSecret = doc.items.find((z) => z.gmText && z.gmText.enc);
    expect(withSecret, 'ожидался хотя бы один зашифрованный gmText в экспорте').toBeTruthy();
    expect(withSecret.gmText.v).toBe(2);
    expect(typeof withSecret.gmText.ct).toBe('string');
    // побайтово нет ни одного plaintext-поля gmText — та же дисциплина, что golden.spec.js 8в
    for (const item of doc.items) {
      const gm = item.gmText;
      const ok = gm === '' || (gm && gm.enc === true && typeof gm.ct === 'string' && gm.ct.length > 0);
      expect(ok, `${item.id}: gmText не enc-блок и не пустая строка`).toBe(true);
    }
  });

  test('11) конфликт с репо: baseline≠live → баннер; «Сбросить» → черновик чистится, приходят live-данные', async ({ page }) => {
    await page.goto('/?engine=leaflet&gmfixture=empty', { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.DKEditor);
    await unlockSetup(page, 'e2e-editor-pw');

    // реальная правка — без неё черновика (и baseline) ещё не существует, сравнивать не с чем
    await page.waitForSelector('.dk-editor-zone');
    await page.click('.dk-editor-zone');
    await page.fill('#z_name', 'Правка перед конфликтом');
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => !!localStorage.getItem('dk_work_v2_baseline'))).toBe(true);

    await page.click('#masterBtn'); // lock

    await page.route('**/gm-empty-zones.json', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        schema: 'dk-map/v2', mapOrientation: 'v2',
        items: [{
          id: 'fx_empty_zone_1', name: 'Изменено извне', band: '', owner: '[TBD]', status: 'known',
          playerText: 'x', gmText: '', polygon: [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2], [0.1, 0.2]],
        }],
      }),
    }));

    await unlockSetup(page, 'e2e-editor-pw');
    await page.waitForTimeout(150);

    expect(await page.evaluate(() => window.DKEditor.hasConflict())).toBe(true);
    await expect(page.locator('#side')).toContainText('репозитории изменились');
    // черновик (с правкой) не тронут конфликт-детектом сам по себе
    expect(await page.evaluate(() => window.DKEditor.getZones()[0].name)).toBe('Правка перед конфликтом');

    page.once('dialog', (d) => d.accept());
    await page.click('#conflictReset');
    await page.waitForTimeout(150);

    expect(await page.evaluate(() => window.DKEditor.hasConflict())).toBe(false);
    expect(await page.evaluate(() => window.DKEditor.getZones()[0].name)).toBe('Изменено извне');
    expect(await page.evaluate(() => localStorage.getItem('dk_work_v2'))).toBeNull();
  });

  test('12) редактор недоступен без разлочки', async ({ page }) => {
    await page.goto('/?engine=leaflet&gmfixture=empty', { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.DKEditor);

    await expect(page.locator('#side')).toHaveClass(/hidden/);
    await expect(page.locator('.dk-editor-zone')).toHaveCount(0);
    const menuBtnVisible = await page.evaluate(() => getComputedStyle(document.getElementById('menuBtn')).display !== 'none');
    expect(menuBtnVisible).toBe(false);
    expect(await page.evaluate(() => window.DKGM.isUnlocked())).toBe(false);
  });

  // 13) сквозной жизненный цикл на КЛОНЕ боевой геометрии (9 реальных зон + 2 реальных
  // маркера, tests/fixtures/lifecycle-{zones,markers}.json — та же геометрия/имена, что в
  // data/v2, но gmText целиком перешифрован фикстурным паролем при генерации фикстуры;
  // боевой шифртекст/пароль в тесте не участвуют вообще). Заменяет ручную приёмку —
  // Иван делает короткую живую проверку поверх этого прогона, не полную вручную.
  //
  // Клик по конкретному реальному полигону — через locator.dispatchEvent('click'), не
  // page.click()/page.mouse.click(): реальные районы вложены и перекрываются в экранных
  // координатах (outskirts — внешнее кольцо, внутри него — другие районы), обычный клик
  // по геометрическому центру ббокса регулярно попадает в чужой (топовый по z) полигон.
  // dispatchEvent бьёт напрямую в DOM-узел по data-zone-id/data-marker-id, минуя hit-test.
  test('13) сквозной жизненный цикл на клоне боевых данных (N зон + 2 маркера)', async ({ page }) => {
    let newZoneId, newMarkerId, baseZones, baseMarkers;

    await test.step('unlock (фикстурный пароль на клоне боевой геометрии)', async () => {
      await page.goto('/?engine=leaflet&gmfixture=lifecycle', { waitUntil: 'load' });
      await page.waitForFunction(() => !!window.DKEditor);
      await unlockSetup(page, LIFECYCLE_PW);
      await page.waitForTimeout(150);
    });

    await test.step('N зон + 2 маркера, с подписями', async () => {
      // Число зон читаем из живых данных, а не хардкодим — lifecycle-фикстура клонирует
      // ТЕКУЩИЙ data/v2/zones.json (см. tests/global-setup.js), число реальных районов
      // меняется по мере правки мировых данных (world data commits).
      baseZones = await page.evaluate(() => window.DKEditor.getZones().length);
      baseMarkers = await page.evaluate(() => window.DKEditor.getMarkers().length);
      expect(baseMarkers).toBe(2);
      await expect(page.locator('.dk-editor-zlabel')).toHaveCount(baseZones);
      await expect(page.locator('.dk-editor-mlabel')).toHaveCount(baseMarkers);
      await expect(page.locator('#side')).toContainText(`Зон: ${baseZones} · маркеров: ${baseMarkers}`);
    });

    await test.step('нарисовать зону', async () => {
      // за пределами печатного листа (x>1) — единственное гарантированно свободное от
      // реальных районов место (они тайлят весь лист без зазоров), см. normToScreen()
      const corners = await Promise.all([
        normToScreen(page, 1.02, 0.40), normToScreen(page, 1.06, 0.40),
        normToScreen(page, 1.06, 0.45), normToScreen(page, 1.02, 0.45),
      ]);
      await page.click('#drawZoneBtn');
      for (const p of corners) { await page.mouse.click(p.x, p.y); await page.waitForTimeout(30); }
      await page.keyboard.press('Enter');
      await page.waitForTimeout(100);
      const zones = await page.evaluate(() => window.DKEditor.getZones());
      expect(zones.length).toBe(baseZones + 1);
      newZoneId = zones[zones.length - 1].id;
      await expect(page.locator('#side')).toContainText(`Зон: ${baseZones + 1} · маркеров: ${baseMarkers}`);
    });

    await test.step('статус → вырез в DOM тумана', async () => {
      // новая зона уже выбрана (finishZone ставит sel на неё)
      await page.waitForSelector('.statusgrid');
      await page.click('.statusgrid .sb-scouted');
      await page.waitForTimeout(50);
      const fill = await page.evaluate((id) => {
        const el = document.querySelector(`#map svg .leaf-hazezone[data-zone="${id}"]`);
        return el ? el.getAttribute('fill') : null;
      }, newZoneId);
      expect(fill).toBe('#262626'); // FOG_HEX.scouted, см. js/fog-engine.js
    });

    await test.step('маркер с авто-зоной', async () => {
      const center = await normToScreen(page, 1.04, 0.425); // центр только что нарисованного прямоугольника
      await page.click('#addMarkerBtn');
      await page.mouse.click(center.x, center.y);
      await page.waitForTimeout(100);
      const markers = await page.evaluate(() => window.DKEditor.getMarkers());
      expect(markers.length).toBe(baseMarkers + 1);
      const last = markers[markers.length - 1];
      expect(last.zone).toBe(newZoneId);
      newMarkerId = last.id;
    });

    await test.step('gmText с debounce (правка существующей боевой заметки)', async () => {
      await page.locator('.dk-editor-zone[data-zone-id="outskirts"]').dispatchEvent('click');
      await page.waitForSelector('#z_gtext:not([disabled])');
      await page.fill('#z_gtext', 'Обновлённая тайна автора перед перезагрузкой');
      await page.waitForTimeout(600);
      const gm = await page.evaluate(() => window.DKEditor.getZones().find((z) => z.id === 'outskirts').gmText);
      expect(gm.enc).toBe(true); expect(gm.v).toBe(2);
    });

    await test.step('RELOAD → черновик жив', async () => {
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => !!window.DKEditor);
      // ключ шифрования — только в памяти, теряется на релоаде; данные (черновик) — в localStorage
      expect(await page.evaluate(() => window.DKGM.isUnlocked())).toBe(false);
      await unlockSetup(page, LIFECYCLE_PW);
      await page.waitForTimeout(150);

      const zones = await page.evaluate(() => window.DKEditor.getZones());
      const markers = await page.evaluate(() => window.DKEditor.getMarkers());
      expect(zones.length).toBe(baseZones + 1);
      expect(markers.length).toBe(baseMarkers + 1);
      expect(zones.find((z) => z.id === newZoneId)).toBeTruthy();
      expect(markers.find((m) => m.id === newMarkerId)).toBeTruthy();

      const outskirts = zones.find((z) => z.id === 'outskirts');
      const plain = await page.evaluate(async (z) => {
        const ks = window.DKGM.getKeyAndSalt();
        return DKCrypto.aesDecrypt(ks.key, z.gmText, z.id);
      }, outskirts);
      expect(plain).toBe('Обновлённая тайна автора перед перезагрузкой');
    });

    await test.step('перерисовка контура', async () => {
      await page.locator('.dk-editor-zone[data-zone-id="outskirts"]').dispatchEvent('click');
      await page.waitForSelector('#z_redraw');
      const before = await page.evaluate(() => window.DKEditor.getZones().find((z) => z.id === 'outskirts'));
      await page.click('#z_redraw');
      for (const [x, y] of [[700, 200], [760, 200], [760, 260]]) {
        await page.mouse.click(x, y);
        await page.waitForTimeout(30);
      }
      await page.keyboard.press('Enter');
      await page.waitForTimeout(100);
      const after = await page.evaluate(() => window.DKEditor.getZones().find((z) => z.id === 'outskirts'));
      expect(after.id).toBe(before.id);
      expect(after.name).toBe(before.name);
      expect(after.polygon.length).toBe(3);
      expect(after.polygon).not.toEqual(before.polygon);
    });

    await test.step('экспорт → парсинг файла (v2-обёртка, enc-блоки, N+1 зон)', async () => {
      await page.click('#menuBtn');
      await page.waitForSelector('#menuModal.show');
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.click('#exportZones'),
      ]);
      const doc = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
      expect(doc.schema).toBe('dk-map/v2');
      expect(doc.mapOrientation).toBe('v2');
      expect(doc.items.length).toBe(baseZones + 1);
      const encCount = doc.items.filter((z) => z.gmText && z.gmText.enc === true).length;
      expect(encCount).toBeGreaterThan(0);
      for (const item of doc.items) {
        const gm = item.gmText;
        const ok = gm === '' || (gm && gm.enc === true && gm.v === 2 && typeof gm.ct === 'string' && gm.ct.length > 0);
        expect(ok, `${item.id}: некорректный gmText в экспорте`).toBe(true);
      }
      await page.click('#menuClose');
    });

    await test.step('удаление добавленных зоны и маркера → назад к N·2', async () => {
      await page.locator(`.dk-marker[data-marker-id="${newMarkerId}"]`).dispatchEvent('click');
      await page.waitForSelector('#m_del');
      page.once('dialog', (d) => d.accept());
      await page.click('#m_del');
      await page.waitForTimeout(80);

      await page.locator(`.dk-editor-zone[data-zone-id="${newZoneId}"]`).dispatchEvent('click');
      await page.waitForSelector('#z_del');
      page.once('dialog', (d) => d.accept());
      await page.click('#z_del');
      await page.waitForTimeout(80);

      const zones = await page.evaluate(() => window.DKEditor.getZones().length);
      const markers = await page.evaluate(() => window.DKEditor.getMarkers().length);
      expect(zones).toBe(baseZones);
      expect(markers).toBe(baseMarkers);
      await expect(page.locator('#side')).toContainText(`Зон: ${baseZones} · маркеров: ${baseMarkers}`);
    });

    await test.step('сброс правок', async () => {
      await page.click('#menuBtn');
      await page.waitForSelector('#menuModal.show');
      page.once('dialog', (d) => d.accept());
      await page.click('#resetWork');
      await page.waitForTimeout(150);
      expect(await page.evaluate(() => localStorage.getItem('dk_work_v2'))).toBeNull();
      expect(await page.evaluate(() => window.DKEditor.getZones().length)).toBe(baseZones);
    });

    await test.step('lock → возврат к read-виду', async () => {
      await page.click('#masterBtn');
      await page.waitForTimeout(150);
      await expect(page.locator('#side')).toHaveClass(/hidden/);
      await expect(page.locator('.dk-editor-zone')).toHaveCount(0);
      // read-слой markers-engine.js — реальные data/v2/markers.json, независимо от ?gmfixture
      await expect(page.locator('.dk-marker[data-marker-id="embervud"]')).toHaveCount(1);
      expect(await page.evaluate(() => window.DKGM.isUnlocked())).toBe(false);
    });
  });
});
