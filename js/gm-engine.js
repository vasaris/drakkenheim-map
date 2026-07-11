// Ф3.5а: GM-слой (разлочка) для Leaflet-движка (?engine=leaflet). Расшифровывает gmText
// зон/маркеров паролем мастера — ключ живёт ТОЛЬКО в памяти вкладки (в этом замыкании),
// никогда не пишется в localStorage/IndexedDB/консоль. Только эта ветка бутстрапа —
// app.js (v1, редактор + свой GM-слой) не трогается.
//
// UI переиспользует разметку #masterBtn/#masterModal из index.html (общая с v1, но v1 её
// не грузит на ветке ?engine=leaflet — конфликта обработчиков нет).
//
// Ф3.5б: read-панель в #side (renderPanel/itemBlock) УДАЛЕНА — её заменяет форма
// редактора в js/editor-engine.js (показывает playerText+gmText при выборе объекта И
// даёт их редактировать; отдельный список-дублёр не нужен). gm-engine.js теперь только
// разлочивает и отдаёт сессионный ключ через window.DKGM.getKeyAndSalt() +
// подписку window.DKGM.onChange(cb) — кто угодно (editor-engine.js) реагирует на
// unlock/lock, не опрашивая gmKey напрямую (он приватный).
(function () {
  var DK = window.DKMapEngine;
  var DKCrypto = window.DKCrypto;
  if (!DK) { console.error('gm-engine: window.DKMapEngine не найден — map-engine.js должен грузиться раньше'); return; }
  if (!DKCrypto) { console.error('gm-engine: window.DKCrypto не найден — gm-crypto.js должен грузиться раньше'); return; }

  var $ = function (s) { return document.querySelector(s); };

  // ?gmfixture=1 -> tests/fixtures/gm-fixture-*.json (enc-блоки на тестовом пароле);
  // ?gmfixture=empty -> tests/fixtures/gm-empty-*.json (0 enc-блоков, флоу "задать пароль");
  // ?gmfixture=lifecycle -> tests/fixtures/lifecycle-*.json (клон РЕАЛЬНОЙ геометрии/имён
  // data/v3, но gmText целиком перешифрован фикстурным паролем при генерации фикстуры —
  // боевой шифртекст туда не попадает; см. tests/editor.spec.js сценарий 13, сквозной
  // жизненный цикл на реалистичном объёме данных).
  // Без параметра — боевые data/v3/*.json. См. tests/gm.spec.js.
  var Q = new URLSearchParams(location.search);
  var fx = Q.get('gmfixture');
  var ZONES_URL = fx === 'empty' ? 'tests/fixtures/gm-empty-zones.json'
    : fx === 'lifecycle' ? 'tests/fixtures/lifecycle-zones.json'
    : fx ? 'tests/fixtures/gm-fixture-zones.json'
    : 'data/v3/zones.json';
  var MARKERS_URL = fx === 'empty' ? 'tests/fixtures/gm-empty-markers.json'
    : fx === 'lifecycle' ? 'tests/fixtures/lifecycle-markers.json'
    : fx ? 'tests/fixtures/gm-fixture-markers.json'
    : 'data/v3/markers.json';

  var zones = [], markers = [];
  var gmKey = null, gmSalt = null;
  var gmPlain = {}; // "z:"+id / "m:"+id -> расшифрованный текст, только в памяти (читает markers-engine.js попап)
  var changeListeners = []; // подписчики window.DKGM.onChange — editor-engine.js реагирует на unlock/lock

  function notifyChange() {
    var unlocked = !!gmKey;
    changeListeners.forEach(function (cb) {
      try { cb(unlocked); } catch (e) { console.error('gm-engine: onChange-подписчик упал', e); }
    });
  }

  function encBlocks() {
    var out = [];
    zones.forEach(function (z) { if (DKCrypto.isEnc(z.gmText)) out.push(z.gmText); });
    markers.forEach(function (m) { if (DKCrypto.isEnc(m.gmText)) out.push(m.gmText); });
    return out;
  }

  // Расшифровывает все enc-блоки паролем; коммитит gmKey/gmPlain только если ВСЕ
  // блоки сошлись (неверный пароль или подмена AAD/id -> GCM auth fail -> ничего не меняем).
  async function unlockGM(password) {
    if (!password) return false;
    var blocks = encBlocks();
    if (!blocks.length) return false; // 0 блоков -> это флоу "задать пароль", см. openModal()
    var salt = DKCrypto.unb64(blocks[0].salt);
    var key;
    try { key = await DKCrypto.deriveKey(password, salt); } catch (e) { return false; }
    var tmp = {};
    var legacyIds = [];
    try {
      for (var zi = 0; zi < zones.length; zi++) {
        var z = zones[zi];
        if (DKCrypto.isEnc(z.gmText)) {
          var legacyZ = DKCrypto.isLegacyBlock(z.gmText);
          if (legacyZ) legacyIds.push('zone:' + z.id);
          tmp['z:' + z.id] = await DKCrypto.aesDecrypt(key, z.gmText, legacyZ ? undefined : z.id);
        } else {
          tmp['z:' + z.id] = typeof z.gmText === 'string' ? z.gmText : '';
        }
      }
      for (var mi = 0; mi < markers.length; mi++) {
        var m = markers[mi];
        if (DKCrypto.isEnc(m.gmText)) {
          var legacyM = DKCrypto.isLegacyBlock(m.gmText);
          if (legacyM) legacyIds.push('marker:' + m.id);
          tmp['m:' + m.id] = await DKCrypto.aesDecrypt(key, m.gmText, legacyM ? undefined : m.id);
        } else {
          tmp['m:' + m.id] = typeof m.gmText === 'string' ? m.gmText : '';
        }
      }
    } catch (e) {
      return false; // неверный пароль (или подмена id/AAD) -> gmKey/gmPlain не трогаем
    }
    gmKey = key; gmSalt = salt; Object.assign(gmPlain, tmp);
    legacyIds.forEach(function (id) {
      console.warn('gm-engine: legacy block (' + id + ') — старый формат без AAD; см. scripts/rotate-passphrase.mjs --upgrade');
    });
    return true;
  }

  // Фикс (а): 0 enc-блоков в мире (свежий мир) — не "тихо ок", а явный флоу задания
  // нового пароля мастера (с подтверждением, см. openModal/submitModal, mode='setup').
  async function setupNewMaster(password) {
    if (!password) return false;
    var salt = DKCrypto.randomSalt();
    var key;
    try { key = await DKCrypto.deriveKey(password, salt); } catch (e) { return false; }
    gmKey = key; gmSalt = salt;
    return true;
  }

  function lockGM() {
    gmKey = null; gmSalt = null;
    for (var k in gmPlain) delete gmPlain[k];
  }

  /* ---------- toast (переиспользует #toast из index.html) ---------- */
  var toastT = null;
  function toast(msg) {
    var t = $('#toast'); if (!t) return;
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }

  /* ---------- модалка мастера (переиспользует #masterBtn/#masterModal из index.html) ---------- */
  var masterBtn, modal, pwEl, pwConfirmEl, errEl, titleEl, descEl, okBtn, cancelBtn, modePill;

  // Смежный фикс: modePill — общий с v1 элемент шапки; app.js держит его в синхроне со
  // своим EDIT-режимом, но на ветке ?engine=leaflet app.js не грузится вовсе, так что без
  // этого пилюля осталась бы навсегда «Карта кампании», даже после разлочки GM.
  function setMasterBtn() {
    if (masterBtn) masterBtn.textContent = gmKey ? 'Запереть GM' : 'Мастер';
    if (modePill) {
      modePill.textContent = gmKey ? 'Режим мастера · GM-слой расшифрован' : 'Карта кампании';
      modePill.classList.toggle('gm', !!gmKey);
    }
  }

  function openModal() {
    errEl.textContent = '';
    pwEl.value = ''; pwConfirmEl.value = '';
    var isSetup = encBlocks().length === 0;
    modal.dataset.mode = isSetup ? 'setup' : 'unlock';
    if (isSetup) {
      titleEl.textContent = 'Задать пароль мастера';
      descEl.textContent = 'В этом мире ещё нет ни одной зашифрованной GM-заметки. Задайте пароль ' +
        'мастера для этой сессии и повторите его для подтверждения. Пароль нигде не сохраняется.';
      pwEl.placeholder = 'Новый пароль мастера';
      pwConfirmEl.style.display = 'block';
    } else {
      titleEl.textContent = 'Вход мастера';
      descEl.textContent = 'Введи пароль мастера, чтобы расшифровать GM-заметки. Пароль нигде не ' +
        'сохраняется — только на эту сессию.';
      pwEl.placeholder = 'Пароль мастера';
      pwConfirmEl.style.display = 'none';
    }
    modal.classList.add('show');
    pwEl.focus();
  }
  function closeModal() { modal.classList.remove('show'); }

  async function submitModal() {
    var mode = modal.dataset.mode;
    if (mode === 'setup') {
      var p1 = pwEl.value, p2 = pwConfirmEl.value;
      if (!p1) { errEl.textContent = 'Введите пароль.'; return; }
      if (p1 !== p2) { errEl.textContent = 'Пароли не совпадают.'; return; }
      var okSet = await setupNewMaster(p1);
      if (!okSet) { errEl.textContent = 'Не удалось задать пароль.'; return; }
      closeModal(); setMasterBtn(); notifyChange();
      toast('Пароль мастера задан для этой сессии');
    } else {
      var okUnlock = await unlockGM(pwEl.value);
      if (!okUnlock) { errEl.textContent = 'Неверный пароль мастера.'; return; }
      closeModal(); setMasterBtn(); notifyChange();
      toast('GM-слой расшифрован');
    }
  }

  function wireUI() {
    masterBtn = $('#masterBtn'); modal = $('#masterModal');
    pwEl = $('#masterPw'); pwConfirmEl = $('#masterPwConfirm'); errEl = $('#masterErr');
    titleEl = $('#masterTitle'); descEl = $('#masterDesc');
    okBtn = $('#masterOk'); cancelBtn = $('#masterCancel'); modePill = $('#modePill');
    if (!masterBtn || !modal || !pwEl || !pwConfirmEl || !errEl || !titleEl || !descEl || !okBtn || !cancelBtn) {
      console.error('gm-engine: не найдены ожидаемые элементы разметки (#masterBtn/#masterModal/...)');
      return;
    }
    setMasterBtn();
    masterBtn.addEventListener('click', function () {
      if (gmKey) { lockGM(); setMasterBtn(); notifyChange(); toast('GM-слой заперт'); return; }
      openModal();
    });
    cancelBtn.addEventListener('click', closeModal);
    okBtn.addEventListener('click', submitModal);
    [pwEl, pwConfirmEl].forEach(function (el) {
      el.addEventListener('keydown', function (e) { if (e.key === 'Enter') submitModal(); });
    });
    // Esc закрывает модалку, только пока она открыта — не мешает другим Esc-хендлерам страницы.
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && modal.classList.contains('show')) closeModal();
    });
  }

  function fetchJSON(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status + ' ' + url));
    });
  }

  Promise.all([fetchJSON(ZONES_URL), fetchJSON(MARKERS_URL)]).then(function (res) {
    zones = (res[0] && res[0].items) || [];
    markers = (res[1] && res[1].items) || [];
    wireUI();
    console.log('gm-engine: готов (' + zones.length + ' зон, ' + markers.length + ' маркеров, ' +
      encBlocks().length + ' enc-блоков, источник ' + ZONES_URL + ')');
  }).catch(function (err) {
    console.error('gm-engine: не удалось загрузить данные', err);
  });

  // Публичный интерфейс. isUnlocked/getPlain — читают markers-engine.js (попап) и тесты
  // (не хардкодят id/тексты). getKeyAndSalt/onChange — Ф3.5б: js/editor-engine.js шифрует
  // gmText тем же сессионным ключом при сохранении и включает/выключает свои инструменты
  // по факту unlock/lock, не опрашивая приватный gmKey напрямую.
  window.DKGM = {
    isUnlocked: function () { return !!gmKey; },
    getPlain: function (kind, id) { return gmPlain[(kind === 'zone' ? 'z:' : 'm:') + id]; },
    getKeyAndSalt: function () { return gmKey ? { key: gmKey, salt: gmSalt } : null; },
    onChange: function (cb) { changeListeners.push(cb); },
  };
})();
