// Ф3.5а: E2E для GM-слоя (?engine=leaflet). Ничего не трогает боевые data/v2/*.json —
// все три сценария идут через tests/fixtures/gm-{fixture,empty}-*.json (?gmfixture=...),
// с тестовым паролем (не боевым, см. tests/fixtures/*.json — сгенерированы отдельно).
// Проверяем и DOM (что реально видит GM), и window.DKGM (состояние без хардкода текстов
// в нескольких местах) — см. js/gm-engine.js экспорт в конце файла.

const { test, expect } = require('@playwright/test');

const FIXTURE_PW = 'e2e-fixture-pw-not-real';

// Живые баги (пойманы Иваном на реальном анлоке, не на E2E — E2E был зелёным оба раза):
//  #1 — клик «Мастер» добавлял .modal.show (DOM «открыто»), но модалку рисовал под Leaflet-
//       панами (z-index 200..1000 у .leaflet-pane/.leaflet-top/.leaflet-bottom/.leaflet-
//       control-container — #map не создаёт свой stacking context, z-index сравнивается
//       напрямую в общем контексте).
//  #2 — после разлочки #side (GM-панель) вообще не показывался: та же причина, но хуже —
//       .side был position:static, а у static-элементов z-index не действует ВООБЩЕ (CSS-
//       спека: positioned-элементы всегда красятся поверх static при пересечении, независимо
//       от z-index/DOM-порядка), так что панель пряталась целиком, даже без тонкого обода,
//       который был виден у модалки.
// Playwright toBeVisible()/click()/fill() НИ ОДИН из этих багов не ловят: их actionability-
// проверка — про pointer-events (hit-testing), а Leaflet-оверлей, который рисуется поверх
// (fog-engine.js L.svgOverlay {interactive:false}), стоит с pointer-events:none — клики
// физически проходят СКВОЗЬ него, тест видит "элемент кликабелен", хотя визуально он закрашен
// слоем сверху. Эмпирически проверено (и на модалке, и на панели): elementFromPoint/
// elementsFromPoint тоже не видят pointer-events:none слой — они тоже про hit-testing, не
// про paint-order. Единственная точная проверка — элемент должен быть positioned (не static,
// иначе z-index не действует) И его z-index должен быть строго выше любого z-index внутри
// #map (Leaflet сам не поднимается выше 1000).
async function assertVisiblyAboveLeaflet(page, selector) {
  await expect(page.locator(selector)).toBeVisible();

  const viewport = page.viewportSize();
  const box = await page.locator(selector).boundingBox();
  expect(box, `${selector} должен иметь bounding box`).toBeTruthy();
  expect(box.width, `${selector} width > 0`).toBeGreaterThan(0);
  expect(box.height, `${selector} height > 0`).toBeGreaterThan(0);
  expect(box.x, `${selector} левый край не левее вьюпорта`).toBeGreaterThanOrEqual(0);
  expect(box.y, `${selector} верхний край не выше вьюпорта`).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, `${selector} правый край в пределах вьюпорта`).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height, `${selector} нижний край в пределах вьюпорта`).toBeLessThanOrEqual(viewport.height);

  // z-index срабатывает только на позиционированном элементе — но необязательно на самом
  // проверяемом узле: если он position:static (как #masterModal .box), защиту даёт ближайший
  // positioned-предок (#masterModal, position:fixed) — весь его поддод красится одним куском
  // на уровне ЕГО z-index. Поэтому идём вверх по дереву до первого не-static, а не смотрим
  // только на сам selector (баг #2 поймал именно так: #side был static САМ, без предка).
  const z = await page.evaluate((sel) => {
    let node = document.querySelector(sel);
    let stackingEl = null;
    while (node) {
      if (getComputedStyle(node).position !== 'static') { stackingEl = node; break; }
      node = node.parentElement;
    }
    const leafletEls = [...document.querySelectorAll(
      '#map .leaflet-pane, #map .leaflet-top, #map .leaflet-bottom, #map .leaflet-control-container'
    )];
    const maxLeafletZ = leafletEls.reduce((max, e) => {
      const v = parseInt(getComputedStyle(e).zIndex, 10) || 0;
      return Math.max(max, v);
    }, 0);
    return {
      stackingElDesc: stackingEl ? (stackingEl.id ? '#' + stackingEl.id : '.' + stackingEl.className) : null,
      zIndex: stackingEl ? (parseInt(getComputedStyle(stackingEl).zIndex, 10) || 0) : null,
      maxLeafletZ,
      leafletElCount: leafletEls.length,
    };
  }, selector);
  expect(z.leafletElCount, 'ожидались Leaflet-паны в DOM (?engine=leaflet)').toBeGreaterThan(0);
  expect(z.stackingElDesc, `${selector} и все его предки — position:static; z-index нигде не действует, #map всегда рисуется поверх`)
    .not.toBeNull();
  expect(z.zIndex, `${selector} защищён стекингом от ${z.stackingElDesc} (z=${z.zIndex}) — должен быть выше Leaflet-панов (max z=${z.maxLeafletZ})`)
    .toBeGreaterThan(z.maxLeafletZ);
}

async function assertModalVisiblyOpen(page) {
  await assertVisiblyAboveLeaflet(page, '#masterModal .box');
  await expect(page.locator('#masterPw')).toBeVisible();
}

async function assertPanelVisiblyOpen(page) {
  await assertVisiblyAboveLeaflet(page, '#side');
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

  test('b) верный пароль (фикстура) — gmText виден и редактируем в форме редактора', async ({ page }) => {
    // Ф3.5б: read-панель Ф3.5а (renderPanel/itemBlock) удалена — её заменяет форма
    // редактора (js/editor-engine.js), показывающая playerText+gmText при выборе
    // объекта на карте. #side остаётся тем же элементом, assertPanelVisiblyOpen всё ещё
    // релевантен (это по-прежнему тот самый бывший баг #2 — только контент другой).
    await page.goto('/?engine=leaflet&gmfixture=1', { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.DKGM && !!window.DKEditor);

    await page.click('#masterBtn');
    await assertModalVisiblyOpen(page);
    await page.fill('#masterPw', FIXTURE_PW);
    await page.click('#masterOk');

    await expect(page.locator('#masterModal')).not.toHaveClass(/show/);
    await page.waitForFunction(() => window.DKGM.isUnlocked());

    await expect(page.locator('#side')).not.toHaveClass(/hidden/);
    await assertPanelVisiblyOpen(page);

    await page.waitForSelector('.dk-editor-zone');
    await page.click('.dk-editor-zone');
    await page.waitForSelector('#z_gtext:not([disabled])');
    await expect(page.locator('#z_ptext')).toHaveValue('Игрокам: фикстурный текст зоны.');
    await expect(page.locator('#z_gtext')).toHaveValue('GM-фикстура: тайна зоны для e2e');

    await page.click('.dk-marker[data-marker-id="fx_marker_1"]');
    await page.waitForSelector('#m_gtext:not([disabled])');
    await expect(page.locator('#m_ptext')).toHaveValue('Игрокам: фикстурный текст маркера.');
    await expect(page.locator('#m_gtext')).toHaveValue('GM-фикстура: тайна маркера для e2e');

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
    await page.waitForFunction(() => !!window.DKGM && !!window.DKEditor);

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
    // в пустом мире нет секретов — выбранный объект показывает пустое GM-поле (не placeholder,
    // а именно пустую расшифровку — нечего было шифровать)
    await page.waitForSelector('.dk-editor-zone');
    await page.click('.dk-editor-zone');
    await page.waitForSelector('#z_gtext:not([disabled])');
    await expect(page.locator('#z_gtext')).toHaveValue('');
  });

  test('d) попап маркера в виде игрока: только playerText, без GM — до разлочки', async ({ page }) => {
    // Ф3.5б-консеквенция: пока GM разлочен, редактор ЗАМЕНЯЕТ read-слой маркеров своим
    // (DKMarkers.setEnabled(false)) — читаемый попап с GM-блоком (Ф3.5а фикс #2) поэтому
    // становится недостижим на время авторского режима: GM видит и правит gmText через
    // форму редактора (см. тест b), а не через попап. Этот тест держит то, что ДЕЙСТВИТЕЛЬНО
    // осталось инвариантом: до разлочки попап игрока никогда не содержит GM-блок, и после
    // разлочки read-слой (с его попапами) не видим на карте вовсе — его место занял редактор.
    await page.goto('/?engine=leaflet&gmfixture=empty', { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.DKGM && !!window.DKEditor);
    await page.waitForSelector('.dk-marker[data-marker-id="embervud"]');

    await page.click('.dk-marker[data-marker-id="embervud"]');
    await expect(page.locator('.leaflet-popup-content')).toBeVisible();
    await expect(page.locator('.dk-marker-pop-gm')).toHaveCount(0);
    await page.click('.leaflet-popup-close-button');

    await page.click('#masterBtn');
    await page.fill('#masterPw', 'diag-only-not-real-pw');
    await page.fill('#masterPwConfirm', 'diag-only-not-real-pw');
    await page.click('#masterOk');
    await page.waitForFunction(() => window.DKGM.isUnlocked());
    await page.waitForTimeout(150);

    // read-слой (и его попапы) скрыт — редактор занял карту своим слоем
    await expect(page.locator('.dk-marker[data-marker-id="embervud"]')).toHaveCount(0);
  });
});
