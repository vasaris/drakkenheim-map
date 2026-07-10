// Ф3.5а: E2E для GM-слоя (?engine=leaflet). Ничего не трогает боевые data/v2/*.json —
// все три сценария идут через tests/fixtures/gm-{fixture,empty}-*.json (?gmfixture=...),
// с тестовым паролем (не боевым, см. tests/fixtures/*.json — сгенерированы отдельно).
// Проверяем и DOM (что реально видит GM), и window.DKGM (состояние без хардкода текстов
// в нескольких местах) — см. js/gm-engine.js экспорт в конце файла.

const { test, expect } = require('@playwright/test');

const FIXTURE_PW = 'e2e-fixture-pw-not-real';

test.describe('E2E: GM-слой (Ф3.5а gm-engine.js)', () => {
  test('a) неверный пароль — внятная ошибка, ничего не разлочено', async ({ page }) => {
    await page.goto('/?engine=leaflet&gmfixture=1', { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.DKGM);

    await page.click('#masterBtn');
    await expect(page.locator('#masterModal')).toHaveClass(/show/);
    await page.fill('#masterPw', 'definitely-the-wrong-password');
    await page.click('#masterOk');

    await expect(page.locator('#masterErr')).toHaveText(/Неверный пароль/);
    // модалка не закрылась, ничего не разлочено
    await expect(page.locator('#masterModal')).toHaveClass(/show/);
    const unlocked = await page.evaluate(() => window.DKGM.isUnlocked());
    expect(unlocked).toBe(false);
    await expect(page.locator('#side')).toHaveClass(/hidden/);
  });

  test('b) верный пароль (фикстура) — gmText виден в панели', async ({ page }) => {
    await page.goto('/?engine=leaflet&gmfixture=1', { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.DKGM);

    await page.click('#masterBtn');
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
