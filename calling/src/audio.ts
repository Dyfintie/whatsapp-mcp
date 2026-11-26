import os from 'node:os';
import path from 'node:path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const AUDIO_SETUP_BIN = path.join(os.homedir(), '.local/bin/whatsapp-audio-setup');

async function runAudio(action: string, ...args: string[]) {
  try {
    await execFileAsync(AUDIO_SETUP_BIN, [action, ...args]);
  } catch {
    // execFile errors can contain every argument, including speech and file paths.
    throw new Error(`Calling audio helper failed during ${action}. Check PipeWire and the local Piper installation.`);
  }
}

export async function speakIntoCall(text: string, voice: string = 'ryan'): Promise<void> {
  if (!text.trim()) return;
  console.error('Speaking into call.');
  await runAudio('speak', text, voice);
}

export async function playFileIntoCall(filePath: string): Promise<void> {
  await runAudio('play', filePath);
}

export async function ensureAudioSetup(): Promise<void> {
  await runAudio('start');
}
