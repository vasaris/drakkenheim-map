// Ф3.5а: юнит-тесты крипто-ядра (js/gm-crypto.js) и чистой логики ротации
// (scripts/rotate-passphrase.mjs) — без браузера, без TTY, без реальных данных.
// Пароли здесь — тестовые фикстуры, не боевые; в реальном коде пароль никогда
// не передаётся аргументом/литералом за пределами тестов.
//
// Запуск: node --test tests/gm-crypto.spec.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import DKCryptoModule from '../js/gm-crypto.js';
import { rotatePassphrase } from '../scripts/rotate-passphrase.mjs';

const DKCrypto = DKCryptoModule;
const TEST_PW = 'test-only-pw-not-real';

test('encrypt -> decrypt round-trip with AAD', async () => {
  const salt = DKCrypto.randomSalt();
  const key = await DKCrypto.deriveKey(TEST_PW, salt);
  const block = await DKCrypto.aesEncrypt(key, salt, 'секрет зоны', 'zoneA');

  assert.equal(block.enc, true);
  assert.equal(block.v, 2);
  assert.equal(DKCrypto.isEnc(block), true);
  assert.equal(DKCrypto.isLegacyBlock(block), false);

  const plaintext = await DKCrypto.aesDecrypt(key, block, 'zoneA');
  assert.equal(plaintext, 'секрет зоны');
});

test('decrypt MUST fail when id (AAD) is swapped between objects', async () => {
  const salt = DKCrypto.randomSalt();
  const key = await DKCrypto.deriveKey(TEST_PW, salt);
  const blockA = await DKCrypto.aesEncrypt(key, salt, 'секрет A', 'zoneA');

  // ciphertext of A "moved" onto object B — AAD binds ct to its own id, so decrypting
  // A's block as if it belonged to B must fail the GCM auth tag, not silently succeed.
  await assert.rejects(() => DKCrypto.aesDecrypt(key, blockA, 'zoneB'));

  // sanity: the original id still works
  const plaintext = await DKCrypto.aesDecrypt(key, blockA, 'zoneA');
  assert.equal(plaintext, 'секрет A');
});

test('decrypt with wrong password fails (GCM auth, not silent garbage)', async () => {
  const salt = DKCrypto.randomSalt();
  const key = await DKCrypto.deriveKey(TEST_PW, salt);
  const wrongKey = await DKCrypto.deriveKey('a-different-password', salt);
  const block = await DKCrypto.aesEncrypt(key, salt, 'секрет', 'zoneA');

  await assert.rejects(() => DKCrypto.aesDecrypt(wrongKey, block, 'zoneA'));
});

test('legacy block (pre-v2, no "v", no AAD) still reads', async () => {
  const salt = DKCrypto.randomSalt();
  const key = await DKCrypto.deriveKey(TEST_PW, salt);

  // построен вручную, минуя aesEncrypt (который всегда пишет v2) — так выглядели
  // блоки до Ф3.5а (см. data/v2/*.json до апгрейда): {enc:true, salt, iv, ct}, без AAD.
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode('старый секрет'));
  const legacyBlock = { enc: true, salt: DKCrypto.b64(salt), iv: DKCrypto.b64(iv), ct: DKCrypto.b64(ct) };

  assert.equal(DKCrypto.isEnc(legacyBlock), true);
  assert.equal(DKCrypto.isLegacyBlock(legacyBlock), true);

  const plaintext = await DKCrypto.aesDecrypt(key, legacyBlock); // без aad — легаси-путь
  assert.equal(plaintext, 'старый секрет');
});

test('rotation on a fixture preserves plaintext and changes every ct/iv/salt', async () => {
  const oldSalt = DKCrypto.randomSalt();
  const oldKey = await DKCrypto.deriveKey('rotate-old-pw', oldSalt);

  const zonesItems = [
    { id: 'z1', name: 'Zone One', gmText: await DKCrypto.aesEncrypt(oldKey, oldSalt, 'тайна z1', 'z1') },
    { id: 'z2', name: 'Zone Two', gmText: '' }, // не зашифровано — должно остаться как есть
  ];
  const markersItems = [
    { id: 'm1', name: 'Marker One', gmText: await DKCrypto.aesEncrypt(oldKey, oldSalt, 'тайна m1', 'm1') },
  ];

  const result = await rotatePassphrase({
    zonesItems, markersItems,
    oldPassword: 'rotate-old-pw',
    newPassword: 'rotate-new-pw',
  });

  const newZ1 = result.zonesItems.find((z) => z.id === 'z1').gmText;
  const oldZ1 = zonesItems[0].gmText;
  assert.notEqual(newZ1.ct, oldZ1.ct);
  assert.notEqual(newZ1.iv, oldZ1.iv);
  assert.notEqual(newZ1.salt, oldZ1.salt);
  assert.equal(newZ1.v, 2);

  const newM1 = result.markersItems.find((m) => m.id === 'm1').gmText;
  assert.notEqual(newM1.salt, markersItems[0].gmText.salt);
  // новый salt общий на весь прогон (одна PBKDF2-derive), как и в текущей боевой схеме
  assert.equal(newZ1.salt, newM1.salt);

  // не тронутый элемент остаётся ровно как был
  const z2 = result.zonesItems.find((z) => z.id === 'z2');
  assert.equal(z2.gmText, '');

  const newKey = await DKCrypto.deriveKey('rotate-new-pw', DKCrypto.unb64(newZ1.salt));
  assert.equal(await DKCrypto.aesDecrypt(newKey, newZ1, 'z1'), 'тайна z1');
  assert.equal(await DKCrypto.aesDecrypt(newKey, newM1, 'm1'), 'тайна m1');
});

test('rotation aborts (throws) on wrong old password — no partial result to worry about', async () => {
  const oldSalt = DKCrypto.randomSalt();
  const oldKey = await DKCrypto.deriveKey('correct-old-pw', oldSalt);
  const zonesItems = [{ id: 'z1', gmText: await DKCrypto.aesEncrypt(oldKey, oldSalt, 'секрет', 'z1') }];

  await assert.rejects(() => rotatePassphrase({
    zonesItems, markersItems: [],
    oldPassword: 'wrong-old-pw',
    newPassword: 'new-pw',
  }));
});
