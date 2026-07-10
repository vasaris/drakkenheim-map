// @ts-check
const { defineConfig, devices } = require('@playwright/test');
const path = require('path');

// Стенд dk-spike — внешний зафиксированный референс (см. js/fog-engine.js шапку),
// не часть этого репо. Абсолютный путь — локальная машина Ивана.
const STAND_DIR = path.join(require('os').homedir(), 'Downloads', 'dk-spike');

module.exports = defineConfig({
  testDir: 'tests',
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  timeout: 60_000,
  globalSetup: require.resolve('./tests/global-setup.js'),
  use: {
    baseURL: 'http://localhost:8032',
    ...devices['Desktop Chrome'],
  },
  webServer: [
    {
      command: 'python3 -m http.server 8032',
      cwd: __dirname,
      port: 8032,
      reuseExistingServer: true,
      timeout: 10_000,
      stdout: 'ignore',
      stderr: 'ignore',
    },
    {
      command: `python3 -m http.server 8033`,
      cwd: STAND_DIR,
      port: 8033,
      reuseExistingServer: true,
      timeout: 10_000,
      stdout: 'ignore',
      stderr: 'ignore',
    },
  ],
});
