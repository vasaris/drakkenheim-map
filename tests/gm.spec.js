// Ф3.5а: E2E для GM-слоя (?engine=leaflet). Ничего не трогает боевые data/v2/*.json —
// все три сценария идут через tests/fixtures/gm-{fixture,empty}-*.json (?gmfixture=...),
// с тестовым паролем (не боевым, см. tests/fixtures/*.json — сгенерированы отдельно).
// Проверяем и DOM (что реально видит GM), и window.DKGM (состояние без хардкода текстов
// в нескольких местах) — см. js/gm-engine.js экспорт в конце файла.

const { test, expect } = require('@playwright/test');

const FIXTURE_PW = 'e2e-fixture-pw-not-real';

// Живой баг (пойман Иваном): клик «Мастер» на ?engine=leaflet добавлял .modal.show (DOM
// «открыто» — E2E на toHaveClass/click/fill проходил), но модалку рисовал под Leaflet-
// панами (z-index 200..1000 у .leaflet-pane/.leaflet-top/.leaflet-bottom/.leaflet-control-
// container, см. js/vendor/leaflet/leaflet.css — #map не создаёт свой stacking context,
// z-index сравнивается напрямую в общем контексте). Playwright toBeVisible()/click()/fill()
// это НЕ ловят: их actionability-проверка — про pointer-events (hit-testing), а Leaflet-
// оверлей, который рисуется поверх (fog-engine.js L.svgOverlay {interactive:false}), стоит
// с pointer-events:none — клики физически проходят СКВОЗЬ него к инпуту под ним, тест видит
// "элемент кликабелен", хотя визуально он закрашен слоем сверху. Эмпирически проверено:
// elementFromPoint/elementsFromPoint тоже не видят pointer-events:none слой — они тоже про
// hit-testing, не про paint-order. Единственная точная проверка — z-index модалки должен
// быть строго выше любого z-index внутри #map (Leaflet сам не поднимается выше 1000).
async function assertModalVisiblyOpen(page) {
  await expect(page.locator('#masterModal .box')).toBeVisible();
  await expect(page.locator('#masterPw')).toBeVisible();

  const viewport = page.viewportSize();
  const box = await page.locator('#masterModal .box').boundingBox();
  expect(box, '.box должен иметь bounding box').toBeTruthy();
  expect(box.width, '.box width > 0').toBeGreaterThan(0);
  expect(box.height, '.box height > 0').toBeGreaterThan(0);
  expect(box.x, '.box левый край не левее вьюпорта').toBeGreaterThanOrEqual(0);
  expect(box.y, '.box верхний край не выше вьюпорта').toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, '.box правый край в пределах вьюпорта').toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height, '.box нижний край в пределах вьюпорта').toBeLessThanOrEqual(viewport.height);

  const z = await page.evaluate(() => {
    const modalZ = parseInt(getComputedStyle(document.getElementById('masterModal')).zIndex, 10) || 0;
    const leafletEls = [...document.querySelectorAll(
      '#map .leaflet-pane, #map .leaflet-top, #map .leaflet-bottom, #map .leaflet-control-container'
    )];
    const maxLeafletZ = leafletEls.reduce((max, el) => {
      const v = parseInt(getComputedStyle(el).zIndex, 10) || 0;
      return Math.max(max, v);
    }, 0);
    return { modalZ, maxLeafletZ, leafletElCount: leafletEls.length };
  });
  expect(z.leafletElCount, 'ожидались Leaflet-паны в DOM (?engine=leaflet)').toBeGreaterThan(0);
  expect(z.modalZ, `модалка (z=${z.modalZ}) должна рисоваться поверх Leaflet-панов (max z=${z.maxLeafletZ})`)
    .toBeGreaterThan(z.maxLeafletZ);
}

test.describe('E2E: GM-слой (Ф3.5а gm-engine.js)', () => {
  test('a) неверный пароль — внятная ошибка, ничего не разлочено', async ({ page }) => {
    await page.goto('/?engine=leaflet&gmfixture=1', { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.DKGM);

    await page.click('#masterBtn');
    await expect(page.locator('#masterModal')).toHaveClass(/show/);
    await assertModalVisiblyOpen(page);
    await page.fill('#masterPw', 'definitely-the-wrong-password');
    await page.click('#masterOk');

    await expect(page.locator('#masterErr')).toHaveText(/Неверный пароль/);
    // модалка не закрылась, ничего не разлочено, и всё ещё реально видна (не под картой)
    await expect(page.locator('#masterModal')).toHaveClass(/show/);
    await assertModalVisiblyOpen(page);
    const unlocked = await page.evaluate(() => window.DKGM.isUnlocked());
    expect(unlocked).toBe(false);
    await expect(page.locator('#side')).toHaveClass(/hidden/);

    // требование 1: закрытие по Esc
    await page.keyboard.press('Escape');
    await expect(page.locator('#masterModal')).not.toHaveClass(/show/);
  });

  test('b) верный пароль (фикстура) — gmText виден в панели', async ({ page }) => {
    await page.goto('/?engine=leaflet&gmfixture=1', { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.DKGM);

    await page.click('#masterBtn');
    await assertModalVisiblyOpen(page);
    await page.fill('#masterPw', FIXTURE_PW);
    await page.click('#masterOk');

    // модалка закрылась, разлочено
    await expect(page.locator('#masterModal')).not.toHaveClass(/show/);
    await page.waitForFunction(() => window.DKGM.isUnlocked());

    await expect(page.locator('#side')).not.toHaveClass(/hidden/);
    await expect(page.locator('#side')).toContainText('Фикстурная зона');
    await expect(page.locator('#side')).toContainText('GM-фикстура: тайна зоны для e2e');
    await expect(page.locator('#side')).toContainText('Фикстурный маркер');
    await expect(page.locator('#side')).toContainText('GM-фикстура: тайна маркера для e2e');

    const zonePlain = await page.evaluate(() => window.DKGM.getPlain('zone', 'fx_zone_1'));
    expect(zonePlain).toBe('GM-фикстура: тайна зоны для e2e');

    // Запереть — панель прячется, DKGM возвращается в locked
    await page.click('#masterBtn');
    await expect(page.locator('#side')).toHaveClass(/hidden/);
    const stillUnlocked = await page.evaluate(() => window.DKGM.isUnlocked());
    expect(stillUnlocked).toBe(false);
  });

  test('c) Фикс (а): 0 enc-блоков — явный флоу "задать пароль", не тихий unlock', async ({ page }) => {
    await page.goto('/?engine=leaflet&gmfixture=empty', { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.DKGM);

    await page.click('#masterBtn');
    await expect(page.locator('#masterTitle')).toHaveText(/Задать пароль мастера/);
    await expect(page.locator('#masterPwConfirm')).toBeVisible();
    await assertModalVisiblyOpen(page);

    // пароли не совпадают -> явная ошибка, ничего не установлено
    await page.fill('#masterPw', 'new-master-pw-1');
    await page.fill('#masterPwConfirm', 'new-master-pw-2');
    await page.click('#masterOk');
    await expect(page.locator('#masterErr')).toHaveText(/не совпадают/);
    let unlocked = await page.evaluate(() => window.DKGM.isUnlocked());
    expect(unlocked).toBe(false);

    // совпадающее подтверждение -> сессионный ключ установлен
    await page.fill('#masterPw', 'new-master-pw-1');
    await page.fill('#masterPwConfirm', 'new-master-pw-1');
    await page.click('#masterOk');
    await page.waitForFunction(() => window.DKGM.isUnlocked());
    unlocked = await page.evaluate(() => window.DKGM.isUnlocked());
    expect(unlocked).toBe(true);
    // в пустом мире нет секретов — панель показывает плейсхолдер, а не текст
    await expect(page.locator('#side')).toContainText('— пусто —');
  });
});
