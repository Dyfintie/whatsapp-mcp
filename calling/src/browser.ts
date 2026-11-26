import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import puppeteer, { Browser, Page } from 'puppeteer-core';
import { CONFIG } from './config.js';

async function runningEndpoint(): Promise<string | undefined> {
  let record: string;
  try {
    record = await readFile(path.join(CONFIG.userDataDir, 'DevToolsActivePort'), 'utf8');
  } catch (err: any) {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  }
  const [port, socketPath] = record.trim().split(/\r?\n/);
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535 ||
      !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(socketPath || '')) return undefined;

  const host = '127.0.0.1:' + port;
  const expected = 'ws://' + host + socketPath;
  try {
    const version = await fetch('http://' + host + '/json/version', {
      signal: AbortSignal.timeout(1500), redirect: 'error',
    });
    if (version.ok && (await version.json()).webSocketDebuggerUrl === expected) return expected;
  } catch { /* A previous process can leave a stale profile record. */ }
  return undefined;
}

function attach(endpoint: string): Promise<Browser> {
  return puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null, protocolTimeout: 60000 });
}

export async function getExistingBrowser(): Promise<Browser | undefined> {
  const endpoint = await runningEndpoint();
  if (endpoint) return attach(endpoint);
}

export async function getBrowser(options: { visible?: boolean } = {}): Promise<Browser> {
  const existing = await getExistingBrowser();
  if (existing) return existing;
  await mkdir(CONFIG.userDataDir, { recursive: true, mode: 0o700 });
  const args = [
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    '--user-data-dir=' + CONFIG.userDataDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-features=PreloadMediaEngagementData,MediaEngagementBypassAutoplayPolicies',
    '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    ...(options.visible ? ['--window-size=1200,900'] : ['--headless=new', '--window-size=1280,800']),
    CONFIG.homeUrl,
  ];
  const child = spawn(CONFIG.executablePath, args, {
    detached: true, stdio: 'ignore', env: { ...process.env, PULSE_SOURCE: CONFIG.virtualSource },
  });
  let launchError: Error | undefined;
  child.once('error', err => { launchError = err; });
  child.unref();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    const endpoint = await runningEndpoint();
    if (endpoint) return attach(endpoint);
    if (child.signalCode || (child.exitCode !== null && child.exitCode !== 0))
      throw new Error('The calling browser exited during startup. Check the executable and dedicated profile.');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('The calling profile did not publish its debugging endpoint. Close any older calling window using this profile and try again.');
}

export async function findWhatsAppPage(browser: Browser): Promise<Page | undefined> {
  return (await browser.pages()).find(page => URL.canParse(page.url()) && new URL(page.url()).origin === CONFIG.homeUrl);
}

export async function getWhatsAppPage(browser: Browser): Promise<Page> {
  let page = await findWhatsAppPage(browser);
  if (!page) {
    page = await browser.newPage();
    await page.goto(CONFIG.homeUrl, { waitUntil: 'domcontentloaded' });
    if (new URL(page.url()).origin !== CONFIG.homeUrl) throw new Error('The calling page did not reach WhatsApp Web.');
  }
  await browser.defaultBrowserContext().overridePermissions(CONFIG.homeUrl, ['microphone']);
  return page;
}
