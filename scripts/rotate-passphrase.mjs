#!/usr/bin/env node
// Ф3.5а Фикс (б): смена мастер-пароля / апгрейд формата шифр-блоков gmText в data/v3/*.json.
// (Ф5: репойнт с data/v2 на data/v3 — редактор переключился на v3 ещё в Ф3.5в/Ф3.6,
// этот скрипт остался нацеленным на data/v2 и был бы мёртв после декомиссии v2.)
//
// Пароли — ТОЛЬКО интерактивным вводом (маскированный TTY-прожде), никогда через argv/env:
// они не должны оседать в истории шелла, ps, ci-логах и т.п.
//
//   node scripts/rotate-passphrase.mjs            — смена пароля: старый -> новый (+подтверждение)
//   node scripts/rotate-passphrase.mjs --upgrade   — тот же флоу, но предполагается, что вводится
//                                                     ОДИН И ТОТ ЖЕ пароль дважды (старый=новый) —
//                                                     единственная цель прогона тогда — перевести
//                                                     все блоки (в т.ч. легаси v1, без AAD) в v2
//                                                     с AAD=id. Флаг влияет только на текст подсказок,
//                                                     логика ротации одна и та же в обоих режимах.
//
// Всегда: расшифровка ВСЕХ enc-блоков старым паролем (per-block salt+AAD по формату блока) должна
// пройти целиком, иначе ничего не пишется (atomic — либо все блоки, либо ни одного файла).
// Новый salt — один общий на весь прогон (см. конвенцию app.js: один PBKDF2-derive на разлочку/ротацию).
// Перед перезаписью — .bak рядом (в .gitignore, не коммитить).

import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import DKCryptoModule from '../js/gm-crypto.js';

const DKCrypto = DKCryptoModule;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const ZONES = path.join(ROOT, 'data', 'v3', 'zones.json');
const MARKERS = path.join(ROOT, 'data', 'v3', 'markers.json');

/* ---------- маскированный ввод пароля без внешних зависимостей ---------- */
function promptPassword(question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('нужен интерактивный терминал (TTY) — пароли не читаются из argv/env/пайпа'));
      return;
    }
    process.stdout.write(question);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let input = '';
    function onData(ch) {
      ch = ch.toString();
      const code = ch.charCodeAt(0); // сравнение по коду, а не по control-литералу в исходнике
      if (ch === '\r' || ch === '\n') { cleanup(); process.stdout.write('\n'); resolve(input); return; }
      if (code === 3) { cleanup(); process.stdout.write('\n'); reject(new Error('отменено (Ctrl+C)')); return; } // ETX
      if (code === 127 || ch === '\b') { // DEL / backspace
        if (input.length) { input = input.slice(0, -1); process.stdout.write('\b \b'); }
        return;
      }
      input += ch;
      process.stdout.write('*');
    }
    function cleanup() {
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
    }
    stdin.on('data', onData);
  });
}

/* ---------- чистая логика ротации (без fs/stdin — тестируется напрямую) ---------- */

// Расшифровывает все enc-блоки массива items старым паролем. Ключ дерайвится один раз
// на уникальный salt (кэш) — блоки сегодня делят общий salt, но код не полагается на это.
// Бросает на первой ошибке (неверный пароль / повреждённые данные / подмена id) — вызывающий
// код должен трактовать это как "ничего не менять".
async function decryptAll(items, password) {
  const keyCache = new Map();
  const out = {};
  for (const it of items) {
    const block = it.gmText;
    if (!DKCrypto.isEnc(block)) continue;
    let key = keyCache.get(block.salt);
    if (!key) {
      key = await DKCrypto.deriveKey(password, DKCrypto.unb64(block.salt));
      keyCache.set(block.salt, key);
    }
    const legacy = DKCrypto.isLegacyBlock(block);
    try {
      out[it.id] = await DKCrypto.aesDecrypt(key, block, legacy ? undefined : it.id);
    } catch (e) {
      throw new Error(`decrypt failed for id="${it.id}": неверный старый пароль или повреждённые данные`);
    }
  }
  return out;
}

// Шифрует plainById[it.id] для каждого it, у которого есть расшифрованный текст; остальные
// элементы возвращаются как есть. Всегда пишет v2-блок с AAD=it.id и ОДНИМ общим newSalt.
async function encryptAll(items, plainById, newKey, newSalt) {
  return Promise.all(items.map(async (it) => {
    if (!(it.id in plainById)) return it;
    const gmText = await DKCrypto.aesEncrypt(newKey, newSalt, plainById[it.id], it.id);
    return { ...it, gmText };
  }));
}

// Полная ротация: decrypt-all(old) -> один новый salt/key -> encrypt-all(new) для zones+markers.
// Не трогает fs — принимает/возвращает массивы items. Тестируется без диска и без TTY.
async function rotatePassphrase({ zonesItems, markersItems, oldPassword, newPassword }) {
  const oldPlainZones = await decryptAll(zonesItems, oldPassword);
  const oldPlainMarkers = await decryptAll(markersItems, oldPassword);
  const newSalt = DKCrypto.randomSalt();
  const newKey = await DKCrypto.deriveKey(newPassword, newSalt);
  const newZonesItems = await encryptAll(zonesItems, oldPlainZones, newKey, newSalt);
  const newMarkersItems = await encryptAll(markersItems, oldPlainMarkers, newKey, newSalt);
  return { zonesItems: newZonesItems, markersItems: newMarkersItems };
}

/* ---------- CLI ---------- */
async function main() {
  const upgrade = process.argv.includes('--upgrade');

  const zonesDoc = JSON.parse(readFileSync(ZONES, 'utf8'));
  const markersDoc = JSON.parse(readFileSync(MARKERS, 'utf8'));
  const encCount = [...zonesDoc.items, ...markersDoc.items].filter((it) => DKCrypto.isEnc(it.gmText)).length;

  console.log('=== rotate-passphrase' + (upgrade ? ' --upgrade' : '') + ' ===');
  console.log(`data/v3/zones.json: ${zonesDoc.items.length} зон, data/v3/markers.json: ${markersDoc.items.length} маркеров, из них ${encCount} с зашифрованным gmText.`);
  if (upgrade) {
    console.log('Апгрейд формата (без смены пароля): введите один и тот же пароль дважды ниже.');
  }
  console.log('Пароль не отображается на экране, никуда не пишется и не логируется.\n');

  let oldPassword, newPassword, newPassword2;
  try {
    oldPassword = await promptPassword('Старый пароль мастера: ');
    newPassword = await promptPassword(upgrade ? 'Новый пароль (тот же, что и старый, если это только апгрейд формата): ' : 'Новый пароль мастера: ');
    newPassword2 = await promptPassword('Повторите новый пароль: ');
  } catch (e) {
    console.error('\nПрервано: ' + e.message);
    process.exit(1);
  }

  if (newPassword !== newPassword2) {
    console.error('Новый пароль и подтверждение не совпадают — отмена, файлы не тронуты.');
    process.exit(1);
  }

  let result;
  try {
    result = await rotatePassphrase({
      zonesItems: zonesDoc.items,
      markersItems: markersDoc.items,
      oldPassword,
      newPassword,
    });
  } catch (e) {
    console.error('\nРотация прервана: ' + e.message);
    console.error('Файлы НЕ изменены.');
    process.exit(1);
  }

  copyFileSync(ZONES, ZONES + '.bak');
  copyFileSync(MARKERS, MARKERS + '.bak');
  writeFileSync(ZONES, JSON.stringify({ ...zonesDoc, items: result.zonesItems }, null, 2) + '\n');
  writeFileSync(MARKERS, JSON.stringify({ ...markersDoc, items: result.markersItems }, null, 2) + '\n');

  console.log(`\nГотово: перешифровано ${encCount} блок(ов) в ${result.zonesItems.length} зонах и ${result.markersItems.length} маркерах.`);
  console.log('Бэкапы (не коммитить, есть в .gitignore): data/v3/zones.json.bak, data/v3/markers.json.bak');
  console.log('Дальше: scripts/check-secrets.sh, затем git diff --stat data/v3/, затем коммит.');
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

export { rotatePassphrase, decryptAll, encryptAll };
