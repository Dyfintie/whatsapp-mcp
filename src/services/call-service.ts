import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { ServiceError } from './errors.js';
import type { WhatsAppClient } from './whatsapp-client.js';

const execFileAsync = promisify(execFile);
const WHATSAPP_CALL_BIN = path.join(os.homedir(), '.local/bin/whatsapp-call');
const PIPER_BIN = path.join(os.homedir(), '.local/bin/piper');
const PIPER_VOICES_DIR = path.join(os.homedir(), '.local/share/piper-voices');
type Voice = 'ryan' | 'lessac';
type Runner = (file: string, args: string[], options: { timeout: number; maxBuffer: number }) => Promise<{ stdout: string }>;

export interface DialOptions {
  speakOnConnect?: string;
  voice?: Voice;
  maxWaitSeconds?: number;
}
export interface CallStatus {
  ok: boolean;
  active: boolean;
  state: string;
  duration?: string;
  error?: string;
}
function validateText(text: string) {
  if (!text.trim() || text.length > 4096) throw new ServiceError('INVALID_INPUT', 'Text must contain 1-4096 nonblank characters.');
}
function validateVoice(voice: Voice) {
  if (!['ryan', 'lessac'].includes(voice)) throw new ServiceError('INVALID_INPUT', 'Voice must be ryan or lessac.');
}
async function synthesizeWav(text: string, voice: Voice, output: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = execFile(PIPER_BIN, ['--model', path.join(PIPER_VOICES_DIR, `en_US-${voice}-medium.onnx`), '--output_file', output],
      { timeout: 30000, maxBuffer: 1024 * 1024 }, err => {
        if (err) reject(new ServiceError('TTS_SYNTHESIS_FAILED', 'Piper synthesis failed. Check that Piper and the selected voice model are installed.'));
        else resolve();
      });
    // Missing/crashed Piper can close stdin before it is written; never let EPIPE crash the daemon.
    child.stdin?.on('error', () => reject(new ServiceError('TTS_SYNTHESIS_FAILED', 'Piper input stream closed.')));
    child.stdin?.end(text);
  });
}
export class CallService {
  private synthesizing = 0;
  private dialing = false;
  constructor(private run: Runner = execFileAsync, private synthesize = synthesizeWav) {}

  private async command(args: string[], timeout: number): Promise<any> {
    let stdout: string;
    try {
      ({ stdout } = await this.run(WHATSAPP_CALL_BIN, args, { timeout, maxBuffer: 1024 * 1024 }));
    } catch (err: any) {
      // A killed command may already have placed a call. Never report a partial success or retry it.
      if (err.killed || err.signal) throw new ServiceError('CALL_OUTCOME_UNKNOWN', 'Calling command timed out or was interrupted. Check call status before taking further action.', false);
      if (!err.stdout) throw new ServiceError('CALL_BACKEND_FAILED', 'Calling backend failed. Check that whatsapp-call and its dependencies are installed.');
      stdout = String(err.stdout);
      const data = this.parse(stdout);
      if (data.ok) throw new ServiceError('CALL_BACKEND_FAILED', 'Calling backend exited unsuccessfully. Check call status before retrying.');
      return data;
    }
    return this.parse(stdout);
  }
  private parse(stdout: string): any {
    // Older call-manager builds print progress before their final JSON result.
    const last = stdout.trim().split('\n').at(-1) || '';
    let data: any;
    try { data = JSON.parse(last); } catch { throw new ServiceError('CALL_INVALID_RESPONSE', 'Calling backend returned an invalid response. Check call status before retrying.'); }
    if (!data || typeof data !== 'object' || typeof data.ok !== 'boolean') throw new ServiceError('CALL_INVALID_RESPONSE', 'Calling backend returned an invalid response.');
    return data;
  }
  async dial(recipient: string, opts: DialOptions = {}): Promise<any> {
    if (!recipient.trim() || recipient.length > 200) throw new ServiceError('INVALID_INPUT', 'Recipient must contain 1-200 nonblank characters.');
    const voice = opts.voice || 'ryan', wait = opts.maxWaitSeconds ?? 45;
    validateVoice(voice);
    if (!Number.isInteger(wait) || wait < 5 || wait > 120) throw new ServiceError('INVALID_INPUT', 'Answer timeout must be 5-120 seconds.');
    if (opts.speakOnConnect !== undefined) validateText(opts.speakOnConnect);
    const args = ['dial', '--json', '-v', voice, '-w', String(wait)];
    if (opts.speakOnConnect) args.push('-s', opts.speakOnConnect);
    args.push('--', recipient);
    if (this.dialing) throw new ServiceError('CALL_BUSY', 'Another dial request is already in progress.');
    this.dialing = true;
    try { return await this.command(args, (wait + 90) * 1000 + (opts.speakOnConnect?.length || 0) * 100); }
    finally { this.dialing = false; }
  }
  async hangup(): Promise<any> { return this.command(['hangup', '--json'], 15000); }
  async getStatus(): Promise<CallStatus> {
    try {
      const status = await this.command(['status', '--json'], 10000);
      if (status.ok && (typeof status.active !== 'boolean' || typeof status.state !== 'string')) throw new Error('Malformed status');
      return status.ok ? status : { ...status, active: false, state: 'error' };
    } catch {
      return { ok: false, active: false, state: 'error', error: 'Call status could not be determined.' };
    }
  }
  async speak(text: string, voice: Voice = 'ryan'): Promise<any> {
    validateText(text); validateVoice(voice);
    return this.command(['speak', '-v', voice, '--json', '--', text], 30000 + text.length * 100);
  }
  async sendVoiceNote(client: WhatsAppClient, chatId: string, text: string, opts: { voice?: Voice; request_id?: string } = {}): Promise<any> {
    validateText(text);
    const voice = opts.voice || 'ryan'; validateVoice(voice);
    let dir: string | undefined;
    try {
      return await client.sendSynthesizedVoice(chatId, text, voice, async () => {
        if (this.synthesizing >= 2) throw new ServiceError('TTS_BUSY', 'Two voice syntheses are already active.', true);
        ++this.synthesizing;
        try {
          const base = client.transferRoot ? path.join(client.transferRoot, 'uploads') : os.tmpdir();
          await fs.mkdir(base, { recursive: true, mode: 0o700 });
          dir = await fs.mkdtemp(path.join(base, 'whatsapp-vn-'));
          const wav = path.join(dir, 'voice-note.wav');
          await this.synthesize(text, voice, wav);
          return wav;
        } finally { --this.synthesizing; }
      }, opts.request_id);
    } finally {
      if (dir) await fs.rm(dir, { recursive: true, force: true });
    }
  }
}
export const callService = new CallService();
