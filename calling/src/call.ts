import { Page } from 'puppeteer-core';

export interface CallStatus {
  active: boolean;
  state: 'idle' | 'calling' | 'ringing' | 'connected' | 'ended' | 'unknown';
  duration?: string;
  error?: string;
}

export async function checkCallStatus(page: Page): Promise<CallStatus> {
  return await page.evaluate((): CallStatus => {
    // Look for active call overlay / modal / call controls
    const callModal = document.querySelector('div[data-testid="call-modal"], div[data-testid="incall-controls"], [data-testid="call-ended"]');
    const endCallBtn = document.querySelector('button[aria-label="End call"], span[data-icon="call-end"], [data-testid="call-end"], button[data-testid="incall-hangup"]');

    if (!callModal && !endCallBtn) {
      return { active: false, state: 'idle' };
    }

    const text = (callModal?.textContent || '').toLowerCase();

    if (text.includes('call ended') || text.includes('declined') || text.includes('busy')) {
      return { active: false, state: 'ended' };
    }
    if (text.includes('ringing')) {
      return { active: true, state: 'ringing' };
    }
    if (text.includes('calling')) {
      return { active: true, state: 'calling' };
    }

    // Check for duration timer (e.g., "0:12" or "01:23")
    const timerMatch = text.match(/\b\d{1,2}:\d{2}\b/);
    if (timerMatch) {
      return { active: true, state: 'connected', duration: timerMatch[0] };
    }

    return { active: true, state: 'unknown' };
  });
}

export async function openContactChat(page: Page, queryOrPhone: string): Promise<void> {
  const query = queryOrPhone.trim();
  if (!query) throw new Error('Recipient must not be empty.');
  const isPhone = /^\+?[\d\s().-]+$/.test(query);
  const target = isPhone ? query.replace(/\D/g, '') : query.toLowerCase();
  if (isPhone && !/^\d{7,15}$/.test(target)) {
    throw new Error('Phone numbers must contain 7 to 15 digits, including country code.');
  }
  console.error(`Locating chat for "${query}"...`);

  // Dismiss "Use here" if active
  await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('button, div[role="button"]'));
    const useHere = all.find(el => el.textContent?.trim() === 'Use here');
    if (useHere) (useHere as HTMLElement).click();
  });

  // Search even when a chat is already open; a partial header match is not identity.
  console.error('Searching via WhatsApp search input...');
  const searchInput = await page.waitForSelector('div[contenteditable="true"][data-tab="3"], #side [role="textbox"]', { timeout: 10000 });
  if (searchInput) {
    await searchInput.click();
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(isPhone ? target : query, { delay: 50 });
    await new Promise(r => setTimeout(r, 1500));

    const matches = await page.evaluate((target: string, isPhone: boolean) => {
      const items = Array.from(document.querySelectorAll('#pane-side [role="listitem"], #pane-side [data-testid="cell-frame-container"]'));
      // Some versions nest the cell container inside a listitem. Count each row once.
      const rows = items.filter(item => !items.some(other => other !== item && other.contains(item)));
      const matches = rows.filter(item => {
        // Inspect the contact label, never message previews or the whole row text.
        const label = item.querySelector('span[dir="auto"][title], span[dir="auto"]');
        const name = (label?.getAttribute('title') || label?.textContent || '').trim();
        return isPhone
          ? /^\+?[\d\s().-]+$/.test(name) && name.replace(/\D/g, '') === target
          : name.toLowerCase() === target;
      });
      if (matches.length === 1) (matches[0] as HTMLElement).click();
      return matches.length;
    }, target, isPhone);

    if (matches > 1) throw new Error(`Ambiguous recipient: "${query}" has multiple exact matches.`);
    if (matches === 0) {
      if (!isPhone) throw new Error(`No exact contact match for "${query}".`);
      console.error(`Navigating to WhatsApp chat for full number ${target}...`);
      await page.goto(`https://web.whatsapp.com/send?phone=${target}`, { waitUntil: 'domcontentloaded' });
    }
  } else {
    throw new Error('WhatsApp search input not found.');
  }

  // A pre-existing header is not proof that the selected chat has opened.
  try {
    await page.waitForFunction((target: string, isPhone: boolean) => {
      const name = (document.querySelector('#main header span[dir="auto"]')?.textContent || '').trim();
      return isPhone
        ? /^\+?[\d\s().-]+$/.test(name) && name.replace(/\D/g, '') === target
        : name.toLowerCase() === target;
    }, { timeout: 20000 }, target, isPhone);
  } catch {
    throw new Error(`Could not verify chat recipient "${query}"; refusing to dial.`);
  }
}

let dialInProgress = false;

export async function dialNumber(page: Page, phoneNumberOrName: string, waitMs: number = 45000): Promise<CallStatus> {
  if (!Number.isFinite(waitMs) || waitMs <= 0) throw new Error('Connection wait must be positive.');
  if (dialInProgress) throw new Error('Another dial request is already in progress.');
  dialInProgress = true;
  try {
    const status = await checkCallStatus(page);
    if (status.active) throw new Error(`Cannot dial while a call is active (state: ${status.state}).`);
    return await dialContact(page, phoneNumberOrName, waitMs);
  } finally {
    dialInProgress = false;
  }
}

async function dialContact(page: Page, phoneNumberOrName: string, waitMs: number): Promise<CallStatus> {
  await openContactChat(page, phoneNumberOrName);

  // Dismiss any floating tooltip (like "Now you can make voice and video calls...")
  await page.evaluate(() => {
    const closeBtns = Array.from(document.querySelectorAll('button[aria-label="Close"], [data-icon="x"]'));
    for (const b of closeBtns) {
      (b as HTMLElement).click();
    }
  });

  // Locate the Voice call button in #main header
  console.error('Locating Voice Call button in chat header...');
  const voiceCallSelector = '#main header button[aria-label="Voice call"]';

  const callBtn = await page.waitForSelector(voiceCallSelector, { timeout: 10000 }).catch(() => null);

  if (!callBtn) {
    throw new Error('Voice Call button not found in chat header.');
  }

  console.error('Clicking Voice Call button...');
  await callBtn.click();
  const deadline = Date.now() + waitMs;

  // If a popup confirmation appears, confirm it
  try {
    const confirmation = await page.waitForFunction(() => {
      const button = document.querySelector<HTMLButtonElement>('button[data-testid="popup-controls-ok"]') ||
        Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
          .find(button => button.textContent?.trim() === 'Call');
      if (!button) return false;
      button.click();
      return true;
    }, { timeout: Math.min(2500, waitMs) });
    await confirmation.dispose();
  } catch (err) {
    if (!(err instanceof Error) || err.name !== 'TimeoutError') {
      await hangupCall(page);
      throw err;
    }
  }

  while (Date.now() < deadline) {
    const status = await checkCallStatus(page);
    console.error(`Call state: ${status.state}`);
    if (status.state === 'connected' || status.state === 'ended') return status;
    await new Promise(r => setTimeout(r, Math.max(0, Math.min(1000, deadline - Date.now()))));
  }

  const ended = await hangupCall(page);
  throw new Error(`Timed out waiting for call connection.${ended ? ' Hangup requested.' : ' No hangup control found; call may still be active.'}`);
}

export async function hangupCall(page: Page): Promise<boolean> {
  console.error('Attempting to hang up call...');
  const endCallSelector = [
    'button[aria-label="End call"]',
    'span[data-icon="call-end"]',
    '[data-testid="call-end"]',
    'button[data-testid="incall-hangup"]',
  ].join(', ');

  const endBtn = await page.$(endCallSelector);
  if (!endBtn) {
    console.error('No active call end button found.');
    return false;
  }

  await endBtn.click();
  console.error('Call hangup requested.');
  return true;
}
