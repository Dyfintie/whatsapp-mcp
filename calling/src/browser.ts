import os from 'node:os';
import path from 'node:path';
import puppeteer, { Browser, Page } from 'puppeteer-core';
import { spawn } from 'child_process';
import { CONFIG } from './config.js';

export async function isCdpAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${CONFIG.cdpUrl}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function spawnBrowser(visible: boolean = false): Promise<void> {
  // Ensure virtual audio setup is active
  try {
    await import('child_process').then(cp => cp.execFileSync(path.join(os.homedir(), '.local/bin/whatsapp-audio-setup'), ['start'], { stdio: 'ignore' }));
  } catch {}

  const standardUserAgent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

  const args = [
    `--remote-debugging-port=${CONFIG.cdpPort}`,
    `--user-data-dir=${CONFIG.userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-features=PreloadMediaEngagementData,MediaEngagementBypassAutoplayPolicies',
    `--user-agent=${standardUserAgent}`,
    CONFIG.homeUrl,
  ];

  if (!visible) {
    // For headless or background mode
    args.push('--headless=new');
    args.push('--window-size=1280,800');
  } else {
    args.push('--window-size=1200,900');
  }

  const child = spawn(CONFIG.executablePath, args, {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      PULSE_SOURCE: CONFIG.virtualSource,
    },
  });

  child.unref();

  // Poll until CDP is up (max 15 seconds)
  const start = Date.now();
  while (Date.now() - start < 15000) {
    if (await isCdpAvailable()) return;
    await new Promise(r => setTimeout(r, 400));
  }
  throw new Error('Timed out waiting for Chromium CDP to start.');
}

export async function getBrowser(options: { visible?: boolean; forceLaunch?: boolean } = {}): Promise<Browser> {
  const available = await isCdpAvailable();
  if (!available || options.forceLaunch) {
    await spawnBrowser(options.visible ?? false);
  }

  const browser = await puppeteer.connect({
    browserURL: CONFIG.cdpUrl,
    defaultViewport: null,
    protocolTimeout: 60000,
  });

  return browser;
}

export async function getWhatsAppPage(browser: Browser): Promise<Page> {
  const pages = await browser.pages();
  let page = pages.find(p => p.url().includes('web.whatsapp.com'));

  if (!page) {
    page = await browser.newPage();
  }

  if (!page.url().includes('web.whatsapp.com')) {
    await page.goto(CONFIG.homeUrl, { waitUntil: 'domcontentloaded' });
  }

  // Override permissions so browser dialogs never pop up
  try {
    const context = browser.defaultBrowserContext();
    await context.overridePermissions(CONFIG.homeUrl, ['microphone', 'camera', 'notifications']);
  } catch {}

  return page;
}
