#!/usr/bin/env node
import { Command } from 'commander';
import { getBrowser, getWhatsAppPage, isCdpAvailable, spawnBrowser } from './browser.js';
import { dialNumber, hangupCall, checkCallStatus } from './call.js';
import { ensureAudioSetup, speakIntoCall, playFileIntoCall } from './audio.js';
import { CONFIG } from './config.js';

const program = new Command();

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
    await spawnBrowser(true);
    const browser = await getBrowser({ visible: true });
    const page = await getWhatsAppPage(browser);

    console.log('\nPlease scan the QR code on screen using WhatsApp on your phone:');
    console.log('WhatsApp > Settings > Linked Devices > Link a device');

    // Attempt to capture QR code screenshot for remote terminal users
    try {
      const qrElement = await page.waitForSelector('canvas, div[data-ref]', { timeout: 10000 });
      if (qrElement) {
        await page.screenshot({ path: '/tmp/whatsapp_qr.png' });
        console.log('📸 QR code snapshot saved to: /tmp/whatsapp_qr.png');
      }
    } catch {}

    console.log('Waiting for login to complete...');

    try {
      // Wait for chat list or search bar indicating successful login
      await page.waitForSelector('div[data-tab="3"], div[data-testid="chat-list"], header', { timeout: 300000 });
      console.log('\n✅ Login successful! Session saved to profile.');
    } catch {
      console.log('\n⚠️ Login wait timed out or browser was closed.');
    }
  });

// Start daemon command
program
  .command('start-daemon')
  .description('Start background WhatsApp Web daemon process')
  .action(async () => {
    if (await isCdpAvailable()) {
      console.log('Daemon is already running on port ' + CONFIG.cdpPort);
      process.exit(0);
    }
    console.log('Starting background Chromium daemon...');
    await ensureAudioSetup();
    await spawnBrowser(false);
    const browser = await getBrowser();
    await getWhatsAppPage(browser);
    browser.disconnect();
    console.log('✅ Background daemon ready.');
    process.exit(0);
  });

// Stop daemon command
program
  .command('stop-daemon')
  .description('Stop background Chromium daemon')
  .action(async () => {
    if (!await isCdpAvailable()) {
      console.log('Daemon is not running.');
      process.exit(0);
    }
    const browser = await getBrowser();
    await browser.close();
    console.log('Daemon stopped.');
    process.exit(0);
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
      browser?.disconnect();
    }
  });

// Hangup command
program
  .command('hangup')
  .description('End the current active WhatsApp call')
  .option('--json', 'Output raw JSON')
  .action(async (options) => {
    if (!await isCdpAvailable()) {
      if (options.json) {
        console.log(JSON.stringify({ ok: false, error: 'Daemon is not running.' }));
      } else {
        console.log('No active browser daemon running.');
      }
      process.exit(0);
    }
    const browser = await getBrowser();
    const page = await getWhatsAppPage(browser);
    const ended = await hangupCall(page);
    browser.disconnect();
    if (options.json) {
      console.log(JSON.stringify({ ok: true, state: ended ? 'ended' : 'idle' }));
    } else {
      if (!ended) {
        console.log('No active call found to end.');
      }
    }
    process.exit(0);
  });

// Status command
program
  .command('status')
  .description('Check current WhatsApp call status')
  .option('--json', 'Output raw JSON')
  .action(async (options) => {
    if (!await isCdpAvailable()) {
      if (options.json) {
        console.log(JSON.stringify({ ok: true, active: false, state: 'daemon_not_running' }));
      } else {
        console.log('Daemon is not running.');
      }
      process.exit(0);
    }
    const browser = await getBrowser();
    const page = await getWhatsAppPage(browser);
    const status = await checkCallStatus(page);

    if (options.json) {
      console.log(JSON.stringify({ ok: true, ...status }));
    } else {
      console.log(`Call Active: ${status.active}`);
      console.log(`State:       ${status.state}`);
      if (status.duration) console.log(`Duration:    ${status.duration}`);
    }

    browser.disconnect();
    process.exit(0);
  });

// Speak command
program
  .command('speak <text>')
  .description('Inject synthesized speech into the active call microphone')
  .option('-v, --voice <voice>', 'Voice to use (ryan or lessac)', 'ryan')
  .option('--json', 'Output raw JSON')
  .action(async (text, options) => {
    let browser: Awaited<ReturnType<typeof getBrowser>> | undefined;
    try {
      if (!await isCdpAvailable()) throw new Error('Daemon is not running.');
      browser = await getBrowser();
      const page = await getWhatsAppPage(browser);
      const status = await checkCallStatus(page);
      if (!status.active || status.state !== 'connected') {
        throw new Error(`Cannot speak without a connected call (state: ${status.state}).`);
      }
      await ensureAudioSetup();
      await speakIntoCall(text, options.voice || 'ryan');
      if (options.json) {
        console.log(JSON.stringify({ ok: true, spoken: true, text, voice: options.voice || 'ryan' }));
      }
    } catch (err: any) {
      if (options.json) {
        console.log(JSON.stringify({ ok: false, error: err?.message || String(err) }));
      } else {
        console.error('Speak error:', err);
      }
      process.exitCode = 1;
    } finally {
      browser?.disconnect();
    }
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

await program.parseAsync(process.argv);
