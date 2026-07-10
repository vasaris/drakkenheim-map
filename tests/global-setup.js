// Ф3.3-Т: до прогона любых спеков — убедиться, что тайлы реально доступны.
// tiles/ — локальный симлинк на ~/Downloads/drakkenheim_maphost/tiles_v2 (не в репо,
// не в фикстурах; см. .gitignore). Без него correctness (a) и оба perf-сценария
// молча ловят пустую карту/404 — падают с непонятной причиной. Явная ошибка тут.
//
// Ф3.5б-довесок: сюда же — генерация tests/fixtures/lifecycle-{zones,markers}.json.
// Раньше это был ручной разовый скрипт — фикстура молча устаревала при каждой правке
// data/v2 (ровно так и поймали: правка embervud.name/visibleName в data/v2/markers.json
// не долетала до контакт-листа, пока кто-то не вспоминал перегенерировать вручную).
// Теперь — на каждый прогон тестов, автоматически: клон ТЕКУЩЕЙ геометрии/полей data/v2,
// gmText целиком перешифрован LIFECYCLE_PW (не боевой пароль, ни разу не участвует).
// Файлы — в .gitignore: генерируемые, коммитить нечего, устареть тоже нечему.

const fs = require('fs');
const path = require('path');
const DKCrypto = require('../js/gm-crypto.js');

const LIFECYCLE_PW = 'e2e-lifecycle-pw-not-real';

async function generateLifecycleFixture() {
  const root = path.join(__dirname, '..');
  const zonesReal = JSON.parse(fs.readFileSync(path.join(root, 'data', 'v2', 'zones.json'), 'utf8'));
  const markersReal = JSON.parse(fs.readFileSync(path.join(root, 'data', 'v2', 'markers.json'), 'utf8'));

  const salt = DKCrypto.randomSalt();
  const key = await DKCrypto.deriveKey(LIFECYCLE_PW, salt);

  const zonesOut = { schema: 'dk-map/v2', mapOrientation: 'v2', items: [] };
  for (const z of zonesReal.items) {
    const gmText = await DKCrypto.aesEncrypt(key, salt, 'GM-lifecycle secret for ' + z.id, z.id);
    zonesOut.items.push({
      id: z.id, name: z.name, band: z.band, owner: z.owner, status: z.status,
      playerText: z.playerText, gmText, polygon: z.polygon,
    });
  }

  const markersOut = { schema: 'dk-map/v2', mapOrientation: 'v2', items: [] };
  for (const m of markersReal.items) {
    const gmText = await DKCrypto.aesEncrypt(key, salt, 'GM-lifecycle secret for ' + m.id, m.id);
    markersOut.items.push({
      id: m.id, name: m.name, visibleName: m.visibleName, type: m.type, zone: m.zone,
      status: m.status, playerText: m.playerText, gmText, x: m.x, y: m.y,
    });
  }

  const fixturesDir = path.join(root, 'tests', 'fixtures');
  fs.mkdirSync(fixturesDir, { recursive: true });
  fs.writeFileSync(path.join(fixturesDir, 'lifecycle-zones.json'), JSON.stringify(zonesOut, null, 2) + '\n');
  fs.writeFileSync(path.join(fixturesDir, 'lifecycle-markers.json'), JSON.stringify(markersOut, null, 2) + '\n');
}

module.exports = async function globalSetup() {
  const tilesPath = path.join(__dirname, '..', 'tiles');

  let stat;
  try {
    stat = fs.lstatSync(tilesPath);
  } catch {
    throw new Error(
      'tests/global-setup: tiles/ не найден в корне репо.\n' +
      'Ожидается симлинк tiles -> .../drakkenheim_maphost/tiles_v2 (см. README).\n' +
      'Без него тайлы не загрузятся — correctness(a) и perf-сценарии бессмысленны.'
    );
  }

  if (!stat.isSymbolicLink() && !stat.isDirectory()) {
    throw new Error(`tests/global-setup: tiles/ существует, но это не симлинк и не каталог (${tilesPath}).`);
  }

  const zeroDir = path.join(tilesPath, '0');
  if (!fs.existsSync(zeroDir)) {
    throw new Error(
      `tests/global-setup: tiles/0/ не найден по пути ${tilesPath} — симлинк битый ` +
      'или указывает не на тайл-пирамиду. Проверь цель симлинка.'
    );
  }

  await generateLifecycleFixture();
};

module.exports.LIFECYCLE_PW = LIFECYCLE_PW;
