import { mock } from 'node:test';

const state = process.env.TEST_CALL_STATE || 'connected';
const callState = state === 'audio_error' ? 'connected' : state;
mock.module('../../dist/browser.js', { namedExports: {
  isCdpAvailable: async () => state !== 'daemon_not_running',
  getBrowser: async () => ({ disconnect: () => console.error('MOCK disconnect') }),
  getWhatsAppPage: async () => ({}),
  spawnBrowser: async () => { throw new Error('Unexpected browser spawn'); },
} });
mock.module('../../dist/call.js', { namedExports: {
  dialNumber: async (_page, _recipient, waitMs) => {
    console.error(`MOCK dial wait=${waitMs}`);
    if (state === 'timeout') throw new Error('Timed out waiting for call connection. Hangup requested.');
    return { active: callState === 'connected', state: callState };
  },
  checkCallStatus: async () => ({ active: !['idle', 'ended'].includes(callState), state: callState }),
  hangupCall: async () => { console.error('MOCK hangup'); return true; },
} });
// Use the real audio module and its logging, but never invoke an external process.
mock.module('child_process', { namedExports: {
  execFile: (_bin, args, callback) => {
    console.error(`MOCK audio ${args[0]}`);
    if (state === 'audio_error' && args[0] === 'speak') callback(new Error('Mock audio failure'));
    else callback(null, '', '');
  },
} });
