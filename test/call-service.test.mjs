import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CallService, callService } from '../dist/services/call-service.js';
import { createMcpServer } from '../dist/tools/register.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const forbidden = async () => { throw new Error('Unexpected subprocess'); };
test('invalid input is rejected before invoking a subprocess', async () => {
  const service = new CallService(forbidden, forbidden);
  await assert.rejects(service.speak('   '), { code: 'INVALID_INPUT' });
  await assert.rejects(service.sendVoiceNote({}, '123@s.whatsapp.net', '   '), { code: 'INVALID_INPUT' });
  await assert.rejects(service.dial('   '), { code: 'INVALID_INPUT' });
  await assert.rejects(service.dial('Fixture', { maxWaitSeconds: 0 }), { code: 'INVALID_INPUT' });
  await assert.rejects(service.speak('hello', '../other'), { code: 'INVALID_INPUT' });
});
test('CLI positional values cannot be interpreted as options and progress output is tolerated', async () => {
  const calls = [];
  const service = new CallService(async (file, args) => {
    calls.push(args); return { stdout: 'Progress...\n{"ok":true,"state":"calling"}\n' };
  });
  assert.equal((await service.dial('--help')).ok, true);
  assert.deepEqual(calls[0].slice(-2), ['--', '--help']);
  await service.speak('--help');
  assert.deepEqual(calls[1].slice(-2), ['--', '--help']);
});
test('missing binaries and malformed status produce structured errors', async () => {
  for (const run of [forbidden, async () => ({ stdout: 'not JSON' }), async () => ({ stdout: '{"ok":true}' })]) {
    const status = await new CallService(run).getStatus();
    assert.deepEqual({ ok: status.ok, active: status.active, state: status.state }, { ok: false, active: false, state: 'error' });
  }
});
test('interrupted commands never turn partial stdout into success', async () => {
  const service = new CallService(async () => { throw Object.assign(new Error('private text'), { killed: true, stdout: '{"ok":true}' }); });
  await assert.rejects(service.dial('Fixture'), error => error.code === 'CALL_OUTCOME_UNKNOWN' && !error.message.includes('private text'));
});
test('voice synthesis stays in private uploads and cleans up after success or failure', async t => {
  const transferRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-voice-unit-'));
  t.after(() => fs.rm(transferRoot, {recursive:true, force:true}));
  for (const failure of ['none', 'synthesis', 'send']) {
    let recorded;
    const service = new CallService(forbidden, async (text, voice, file) => {
      recorded = file;
      assert.ok(file.startsWith(path.join(transferRoot, 'uploads') + path.sep));
      assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
      await fs.writeFile(file, 'fixture');
      if (failure === 'synthesis') throw new Error('fixture synthesis error');
    });
    const client = { transferRoot, sendSynthesizedVoice: async (chat, text, voice, create, id) => {
      assert.equal(id, 'voice-1');
      const file = await create(); assert.equal(await fs.readFile(file, 'utf8'), 'fixture');
      if (failure === 'send') throw new Error('fixture send error');
      return { state: 'submitted' };
    } };
    const promise = service.sendVoiceNote(client, 'fixture', 'Hello', { request_id: 'voice-1' });
    if (failure === 'none') assert.equal((await promise).state, 'submitted');
    else await assert.rejects(promise, /fixture/);
    await assert.rejects(fs.stat(path.dirname(recorded)), { code: 'ENOENT' });
  }
});
test('MCP registers all voice tools and propagates backend failures as isError', async t => {
  const server = createMcpServer({ status: { state: 'connected' } });
  const sdk = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await sdk.connect(b);
  t.after(async () => { await sdk.close(); await server.close(); });
  const listed = await sdk.listTools();
  for (const name of ['whatsapp_call_dial', 'whatsapp_call_hangup', 'whatsapp_call_status', 'whatsapp_call_speak', 'whatsapp_send_voice_note']) {
    assert.ok(listed.tools.some(tool => tool.name === name));
  }
  t.mock.method(callService, 'hangup', async () => ({ ok: false, error: 'Daemon unavailable' }));
  const result = await sdk.callTool({ name: 'whatsapp_call_hangup', arguments: {} });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.ok, false);
});

test('overlapping dial requests cannot race the shared browser', async () => {
  let finish;
  const service = new CallService(async () => new Promise(resolve => { finish = resolve; }));
  const pending = service.dial('Fixture');
  await assert.rejects(service.dial('Other fixture'), { code: 'CALL_BUSY' });
  finish({ stdout: '{"ok":true,"state":"connected"}' });
  assert.equal((await pending).state, 'connected');
});
