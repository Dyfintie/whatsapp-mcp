import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCallStatus, dialNumber, openContactChat } from '../dist/call.js';

function setup(t, { names = ['Alice'], header = 'Alice', state = 'idle', nextState = 'connected', confirm = true, endButton = true } = {}) {
  t.mock.method(console, 'log', () => assert.fail('Call progress must not write to stdout'));
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (fn, ms) => { now += ms; fn(); return 0; });
  const events = [];
  const rows = names.map(name => ({
    contains: () => false,
    querySelector: () => ({ textContent: name, getAttribute: () => name }),
    click: () => { events.push(`select:${name}`); header = name; },
  }));
  const end = { click: () => { events.push('hangup'); state = 'ended'; } };
  const doc = {
    body: { textContent: 'Unrelated chat timestamp 12:34' },
    querySelector(selector) {
      if (selector.startsWith('#main header span')) return { textContent: header };
      if (selector.includes('call-modal')) {
        return state === 'idle' ? null : { textContent: state === 'connected' ? 'Alice 0:12' : state === 'unknown' ? 'Alice' : state };
      }
      if (selector.includes('End call')) return state === 'idle' ? null : end;
      if (selector.includes('popup-controls-ok')) return null;
      throw new Error(`Unexpected DOM selector: ${selector}`);
    },
    querySelectorAll(selector) {
      if (selector.startsWith('#pane-side')) return rows;
      if (selector === '[role="dialog"] button') return confirm ? [{ textContent: 'Call', click: () => events.push('confirm') }] : [];
      return [];
    },
  };
  const oldDocument = globalThis.document;
  globalThis.document = doc;
  t.after(() => { globalThis.document = oldDocument; });
  const page = {
    keyboard: {
      down: async () => {}, up: async () => {}, press: async () => {},
      type: async text => events.push(`search:${text}`),
    },
    evaluate: async (fn, ...args) => fn(...args),
    waitForSelector: async selector => {
      assert.ok(!selector.includes(':has-text'));
      if (selector.includes('contenteditable')) return { click: async () => events.push('search-input') };
      if (selector.includes('Voice call')) return { click: async () => { events.push('dial'); state = nextState; } };
      throw new Error(`Unexpected selector: ${selector}`);
    },
    waitForFunction: async (fn, options, ...args) => {
      if (!fn(...args)) {
        if (!args.length) now += options.timeout;
        const error = new Error('Mock wait timed out');
        error.name = 'TimeoutError';
        throw error;
      }
      return { dispose: async () => {} };
    },
    goto: async url => events.push(`goto:${url}`),
    $: async () => endButton ? end : null,
  };
  return { page, events, doc };
}

test('connection requires call UI evidence; ignores body timestamps and ambiguous controls', async t => {
  const { page, doc } = setup(t, { state: 'unknown' });
  assert.deepEqual(await checkCallStatus(page), { active: true, state: 'unknown' });
  doc.querySelector = selector => selector.includes('End call') ? {} : null;
  assert.deepEqual(await checkCallStatus(page), { active: true, state: 'unknown' });
  doc.querySelector = () => null;
  assert.deepEqual(await checkCallStatus(page), { active: false, state: 'idle' });
});

test('exact normalized name wins over fuzzy results and current header', async t => {
  const { page, events } = setup(t, { names: ['Alice Smith', 'ALICE'], header: 'Alice Smith' });
  await openContactChat(page, ' alice ');
  assert.ok(events.includes('select:ALICE'));
  assert.ok(!events.includes('select:Alice Smith'));
});

test('unmatched name never clicks first search result or navigates to a numeric URL', async t => {
  const { page, events } = setup(t, { names: ['Alice Smith'], header: 'Alice Smith' });
  await assert.rejects(openContactChat(page, 'Alice'), /No exact contact/);
  assert.ok(!events.some(e => e.startsWith('select:') || e.startsWith('goto:')));
});

test('duplicate exact names fail without selecting anyone', async t => {
  const { page, events } = setup(t, { names: ['Alice', 'alice'] });
  await assert.rejects(openContactChat(page, 'Alice'), /Ambiguous/);
  assert.ok(!events.some(e => e.startsWith('select:')));
});

test('full phone digits match despite formatting', async t => {
  const { page, events } = setup(t, { names: ['+91 98765 43210'] });
  await openContactChat(page, '+91 (98765) 43210');
  assert.ok(events.includes('select:+91 98765 43210'));
});

test('phone suffix match and stale header cannot authorize dialing', async t => {
  const { page, events } = setup(t, { names: ['+44 98765 43210'], header: '+44 98765 43210' });
  await assert.rejects(dialNumber(page, '+91 98765 43210'), /Could not verify/);
  assert.ok(!events.includes('dial'));
  assert.ok(!events.some(e => e.startsWith('select:')));
  assert.ok(events.includes('goto:https://web.whatsapp.com/send?phone=919876543210'));
});

test('names containing digits remain names', async t => {
  const { page, events } = setup(t, { names: ['Team 7'] });
  await openContactChat(page, 'Team 7');
  assert.ok(events.includes('search:Team 7'));
});

test('dial confirms exact Call text in dialog and waits for connection', async t => {
  const { page, events } = setup(t);
  assert.equal((await dialNumber(page, 'Alice', 3000)).state, 'connected');
  assert.ok(events.includes('confirm'));
});

test('ringing timeout hangs up even when no speech was requested', async t => {
  const { page, events } = setup(t, { nextState: 'ringing', confirm: false });
  await assert.rejects(dialNumber(page, 'Alice', 3500), /Timed out.*Hangup requested/);
  assert.equal(events.filter(e => e === 'hangup').length, 1);
});

test('timeout reports unavailable cleanup honestly', async t => {
  const { page } = setup(t, { nextState: 'ringing', endButton: false });
  await assert.rejects(dialNumber(page, 'Alice', 1000), /call may still be active/);
});

test('an active call blocks dial before chat navigation', async t => {
  const { page, events } = setup(t, { state: 'ringing' });
  await assert.rejects(dialNumber(page, 'Bob'), /call is active/);
  assert.deepEqual(events, []);
});

test('overlapping requests in one process cannot navigate; guard releases on failure', async t => {
  const { page, events } = setup(t);
  let release;
  const firstStatus = new Promise(resolve => { release = resolve; });
  const evaluate = page.evaluate;
  let first = true;
  page.evaluate = (...args) => {
    if (first) { first = false; return firstStatus; }
    return evaluate(...args);
  };
  const pending = dialNumber(page, 'Missing');
  await assert.rejects(dialNumber(page, 'Alice'), /already in progress/);
  assert.deepEqual(events, []);
  release({ active: false, state: 'idle' });
  await assert.rejects(pending, /No exact contact/);
  assert.equal((await dialNumber(page, 'Alice')).state, 'connected');
});
