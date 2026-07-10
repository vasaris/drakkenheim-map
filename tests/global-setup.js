// Ф3.3-Т: до прогона любых спеков — убедиться, что тайлы реально доступны.
// tiles/ — локальный симлинк на ~/Downloads/drakkenheim_maphost/tiles_v2 (не в репо,
// не в фикстурах; см. .gitignore). Без него correctness (a) и оба perf-сценария
// молча ловят пустую карту/404 — падают с непонятной причиной. Явная ошибка тут.

const fs = require('fs');
const path = require('path');

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
};
