import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
function run(args, state = 'connected') {
  const result = spawnSync(process.execPath, [
    '--experimental-test-module-mocks', '--import', './tests/fixtures/cli-runtime.mjs',
    './dist/index.js', ...args, '--json',
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, TEST_CALL_STATE: state }, timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.stdout.trim().split('\n').length, 1, result.stdout + result.stderr);
  return { ...result, json: JSON.parse(result.stdout) };
}

test('JSON dial without speech forwards wait and emits exactly one JSON object', () => {
  const result = run(['dial', 'Alice', '--wait', '0.25']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.json, { ok: true, recipient: 'Alice', state: 'connected', spoken: false });
  assert.match(result.stderr, /wait=250/);
  assert.match(result.stderr, /MOCK disconnect/);
});

test('JSON dial speech keeps real audio progress on stderr', () => {
  const result = run(['dial', 'Alice', '--speak', 'Hello']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.spoken, true);
  assert.match(result.stderr, /Speaking into call/);
  assert.match(result.stderr, /MOCK audio speak/);
});

test('invalid waits fail before audio or browser work', () => {
  for (const wait of ['0', '-1', 'oops', 'Infinity']) {
    const result = run(['dial', 'Alice', '--wait', wait]);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.json.ok, false);
    assert.match(result.json.error, /positive number/);
    assert.doesNotMatch(result.stderr, /MOCK/);
  }
});

test('dial timeout reports JSON error and disconnects', () => {
  const result = run(['dial', 'Alice'], 'timeout');
  assert.equal(result.status, 1);
  assert.equal(result.json.ok, false);
  assert.match(result.json.error, /Timed out/);
  assert.match(result.stderr, /MOCK disconnect/);
});

test('speak requires an observed connected call and never starts a missing daemon', () => {
  for (const state of ['daemon_not_running', 'idle', 'ringing', 'calling', 'unknown', 'ended']) {
    const result = run(['speak', 'Hello'], state);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.json.ok, false);
    assert.doesNotMatch(result.stderr, /MOCK audio/);
    if (state !== 'daemon_not_running') assert.match(result.stderr, /MOCK disconnect/);
  }
});

test('connected speak awaits audio and returns clean JSON', () => {
  const result = run(['speak', 'Hello', '--voice', 'lessac']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.json, { ok: true, spoken: true, text: 'Hello', voice: 'lessac' });
  assert.match(result.stderr, /MOCK audio speak/);
  assert.match(result.stderr, /MOCK disconnect/);
});

test('speak audio failure returns JSON error and disconnects', () => {
  const result = run(['speak', 'Hello'], 'audio_error');
  assert.equal(result.status, 1);
  assert.equal(result.json.ok, false);
  assert.match(result.json.error, /Mock audio failure/);
  assert.match(result.stderr, /MOCK disconnect/);
});

test('hangup progress does not contaminate JSON', () => {
  const result = run(['hangup']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.json, { ok: true, state: 'ended' });
});
