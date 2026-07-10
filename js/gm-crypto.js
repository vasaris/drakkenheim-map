// Ф3.5а: изоморфное крипто-ядро GM-слоя (AES-GCM, ключ из пароля мастера через PBKDF2).
// Работает и как классический <script> в браузере (window.DKCrypto), и как модуль Node
// (scripts/rotate-passphrase.mjs, tests/gm-crypto.spec.mjs) — один код, один источник правды
// для формата шифр-блока. Никакого DOM/fs здесь — только crypto.subtle (Web Crypto API,
// глобально доступен и в браузере, и в Node >=19 без импортов).
//
// Формат блока (v2, текущий): {enc:true, v:2, salt, iv, ct} (все — base64), AAD = id объекта
// (zone.id / marker.id), привязывается при encrypt и проверяется при decrypt — блокирует
// перестановку шифртекстов между объектами (GCM auth tag не сойдётся).
// Легаси-блок (v1, до Ф3.5а): {enc:true, salt, iv, ct} без "v" и без AAD — читается,
// но без привязки к id (см. isLegacyBlock). Апгрейд формата — scripts/rotate-passphrase.mjs --upgrade.
(function (root, factory) {
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  if (typeof root !== 'undefined') root.DKCrypto = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PBKDF2_ITERS = 600000;
  var _enc = new TextEncoder(), _dec = new TextDecoder();

  function isEnc(v) { return !!v && typeof v === 'object' && v.enc === true; }
  function isLegacyBlock(v) { return isEnc(v) && v.v !== 2; }

  function b64(buf) {
    var s = '', a = new Uint8Array(buf);
    for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
    return btoa(s);
  }
  function unb64(str) {
    return Uint8Array.from(atob(str), function (c) { return c.charCodeAt(0); });
  }
  function randomSalt() { return crypto.getRandomValues(new Uint8Array(16)); }

  async function deriveKey(password, salt) {
    var base = await crypto.subtle.importKey('raw', _enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: salt, iterations: PBKDF2_ITERS, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
  }

  // aad, если передан, привязывается как AES-GCM additionalData; блок всегда пишется как v2.
  async function aesEncrypt(key, salt, plaintext, aad) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var params = { name: 'AES-GCM', iv: iv };
    if (aad != null) params.additionalData = _enc.encode(String(aad));
    var ct = await crypto.subtle.encrypt(params, key, _enc.encode(plaintext));
    return { enc: true, v: 2, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
  }

  // Легаси-блок (без "v":2) декодируется без AAD, даже если aad передан — вызывающий код
  // решает, требовать ли aad для v2 (см. isLegacyBlock перед вызовом).
  async function aesDecrypt(key, block, aad) {
    var isV2 = block.v === 2;
    var params = { name: 'AES-GCM', iv: unb64(block.iv) };
    if (isV2) {
      if (aad == null) throw new Error('gm-crypto: v2-блок требует aad для decrypt');
      params.additionalData = _enc.encode(String(aad));
    }
    var pt = await crypto.subtle.decrypt(params, key, unb64(block.ct));
    return _dec.decode(pt);
  }

  return {
    PBKDF2_ITERS: PBKDF2_ITERS,
    isEnc: isEnc,
    isLegacyBlock: isLegacyBlock,
    b64: b64,
    unb64: unb64,
    randomSalt: randomSalt,
    deriveKey: deriveKey,
    aesEncrypt: aesEncrypt,
    aesDecrypt: aesDecrypt,
  };
});
