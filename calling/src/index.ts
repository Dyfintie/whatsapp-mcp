#!/usr/bin/env node
import { Command } from 'commander';
import type { Page } from 'puppeteer-core';
import { getBrowser, getExistingBrowser, getWhatsAppPage, findWhatsAppPage } from './browser.js';
import { dialNumber, hangupCall, checkCallStatus } from './call.js';
import { ensureAudioSetup, speakIntoCall, playFileIntoCall } from './audio.js';
import { CONFIG } from './config.js';

const program = new Command();

// Inspection commands only attach to an existing page, even if a browser exits mid-request.
async function withCurrentPage<T>(work: (page: Page | undefined, running: boolean) => Promise<T>): Promise<T> {
  const browser = await getExistingBrowser();
  try {
    const page = browser && await findWhatsAppPage(browser);
    return await work(page, Boolean(browser));
  } finally {
    await browser?.disconnect();
  }
}

program
  .name('whatsapp-call')
  .description('Automated WhatsApp Web Voice Calling via Puppeteer & PipeWire')
  .version('1.0.0');

// Login command: opens visible browser for initial QR code scan
program
  .command('login')
  .description('Launch visible browser to scan WhatsApp Web QR code and establish persistent session')
  .action(async () => {
    console.log('Launching WhatsApp Web for initial login...');
    console.log(`Profile Directory: ${CONFIG.userDataDir}`);
    const browser = await getBrowser({ visible: true });
    try {
      const page = await getWhatsAppPage(browser);
      console.log('Scan the QR code in the calling window using WhatsApp > Linked devices > Link a device.');
      console.log('If the calling browser is running in the background, use whatsapp-call stop-daemon and run login again.');
      await page.waitForSelector('#pane-side, [data-testid="chat-list"]', { visible: true, timeout: 300000 });
      console.log('Login successful. Session saved to the calling profile.');
    } finally {
      await browser.disconnect();
    }
  });

// Start daemon command
program
  .command('start-daemon')
  .description('Start background WhatsApp Web daemon process')
  .action(async () => {
    await ensureAudioSetup();
    const browser = await getBrowser();
    try {
      await getWhatsAppPage(browser);
      console.log('Background calling browser ready.');
    } finally {
      await browser.disconnect();
    }
  });

// Stop daemon command
program
  .command('stop-daemon')
  .description('Stop background Chromium daemon')
  .action(async () => {
    const browser = await getExistingBrowser();
    if (!browser) {
      console.log('Daemon is not running.');
      return;
    }
    await browser.close();
    console.log('Daemon stopped.');
  });

// Dial command
program
  .command('dial <phone>')
  .description('Dial a phone number or contact name')
  .option('-s, --speak <text>', 'Text to speak once the call connects')
  .option('-v, --voice <voice>', 'Voice to use (ryan or lessac)', 'ryan')
  .option('-w, --wait <seconds>', 'Max seconds to wait for connection', '45')
  .option('--json', 'Output raw JSON')
  .action(async (phone, options) => {
    let browser: Awaited<ReturnType<typeof getBrowser>> | undefined;
    try {
      const waitMs = Number(options.wait) * 1000;
      if (!Number.isFinite(waitMs) || waitMs <= 0) {
        throw new Error('--wait must be a positive number of seconds.');
      }
      await ensureAudioSetup();
      browser = await getBrowser();
      const page = await getWhatsAppPage(browser);

      const status = await dialNumber(page, phone, waitMs);
      let spoken = false;

      if (options.speak && status.state === 'connected') {
        await speakIntoCall(options.speak, options.voice || 'ryan');
        spoken = true;
      }

      if (options.json) {
        console.log(JSON.stringify({ ok: true, recipient: phone, state: status.state, spoken }));
      }
    } catch (err: any) {
      if (options.json) {
        console.log(JSON.stringify({ ok: false, error: err?.message || String(err) }));
      } else {
        console.error('Dial error:', err);
      }
      process.exitCode = 1;
    } finally {
      await browser?.disconnect();
    }
  });

// Hangup command
program
  .command('hangup')
  .description('End the current active WhatsApp call')
  .option('--json', 'Output raw JSON')
  .action(async (options) => {
    const result = await withCurrentPage(async (page, running) => {
      if (!running) return { ok: false, error: 'Daemon is not running.' };
      const ended = page && await hangupCall(page);
      return { ok: true, state: ended ? 'ended' : 'idle' };
    });
    console.log(options.json ? JSON.stringify(result) : result.error || result.state);
  });

// Status command
program
  .command('status')
  .description('Check current WhatsApp call status')
  .option('--json', 'Output raw JSON')
  .action(async (options) => {
    const status = await withCurrentPage(async (page, running) =>
      page ? checkCallStatus(page) : { active: false, state: running ? 'idle' : 'daemon_not_running', duration: undefined });
    if (options.json) {
      console.log(JSON.stringify({ ok: true, ...status }));
    } else {
      console.log(`Call Active: ${status.active}`);
      console.log(`State:       ${status.state}`);
      if (status.duration) console.log(`Duration:    ${status.duration}`);
    }
  });

// Speak command
program
  .command('speak <text>')
  .description('Inject synthesized speech into the active call microphone')
  .option('-v, --voice <voice>', 'Voice to use (ryan or lessac)', 'ryan')
  .option('--json', 'Output raw JSON')
  .action(async (text, options) => {
    await withCurrentPage(async (page, running) => {
      if (!running) throw new Error('Daemon is not running.');
      if (!page) throw new Error('No open WhatsApp calling page.');
      const status = await checkCallStatus(page);
      if (!status.active || status.state !== 'connected') {
        throw new Error(`Cannot speak without a connected call (state: ${status.state}).`);
      }
      await ensureAudioSetup();
      await speakIntoCall(text, options.voice || 'ryan');
      if (options.json) console.log(JSON.stringify({ ok: true, spoken: true, text, voice: options.voice || 'ryan' }));
    });
  });

// Play command
program
  .command('play <file>')
  .description('Play an audio file into the active call microphone')
  .action(async (file) => {
    await ensureAudioSetup();
    await playFileIntoCall(file);
    process.exit(0);
  });

try {
  await program.parseAsync(process.argv);
} catch (err) {
  const error = err instanceof Error ? err.message : 'Calling command failed.';
  if (process.argv.includes('--json')) console.log(JSON.stringify({ ok: false, error }));
  else console.error(error);
  process.exitCode = 1;
}
