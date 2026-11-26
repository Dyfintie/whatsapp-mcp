import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import { CONFIG } from '../dist/config.js';

const attached = [];
mock.module('puppeteer-core', { defaultExport: {
  connect: async options => { attached.push(options.browserWSEndpoint); return { connected: true }; },
} });
const { getExistingBrowser, findWhatsAppPage, getWhatsAppPage } = await import('../dist/browser.js');

test('browser attachment uses the port and instance recorded by the dedicated profile', async t => {
  const prior = CONFIG.userDataDir;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wa-browser-test-'));
  CONFIG.userDataDir = dir;
  t.after(async () => { CONFIG.userDataDir = prior; await rm(dir, { recursive: true }); });
  const url = 'ws://127.0.0.1:54231/devtools/browser/current-instance';
  let advertised = url;
  t.mock.method(globalThis, 'fetch', async input => {
    assert.equal(input, 'http://127.0.0.1:54231/json/version');
    return Response.json({ webSocketDebuggerUrl: advertised });
  });
  assert.equal(await getExistingBrowser(), undefined);
  await writeFile(path.join(dir, 'DevToolsActivePort'), '54231\n/devtools/browser/current-instance\n');
  assert.deepEqual(await getExistingBrowser(), { connected: true });
  advertised = url.replace('current-instance', 'replacement-instance');
  assert.equal(await getExistingBrowser(), undefined);
  assert.deepEqual(attached, [url]);
});

test('page inspection is passive and dialing opens only the WhatsApp origin', async () => {
  const other = { url: () => 'https://example.org/help?site=web.whatsapp.com' };
  const whatsapp = { url: () => CONFIG.homeUrl + '/', goto: async url => assert.equal(url, CONFIG.homeUrl) };
  let pages = [other], opened = 0;
  const permissions = [];
  const browser = {
    pages: async () => pages,
    newPage: async () => { ++opened; return whatsapp; },
    defaultBrowserContext: () => ({ overridePermissions: async (...args) => permissions.push(args) }),
  };
  assert.equal(await findWhatsAppPage(browser), undefined);
  assert.equal(opened, 0);
  assert.deepEqual(permissions, []);
  assert.equal(await getWhatsAppPage(browser), whatsapp);
  assert.equal(opened, 1);
  assert.deepEqual(permissions, [[CONFIG.homeUrl, ['microphone']]]);
  pages = [other, whatsapp];
  assert.equal(await findWhatsAppPage(browser), whatsapp);
});
