import os from 'node:os';
import path from 'node:path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const AUDIO_SETUP_BIN = path.join(os.homedir(), '.local/bin/whatsapp-audio-setup');

export async function speakIntoCall(text: string, voice: string = 'ryan'): Promise<void> {
  if (!text.trim()) return;
  console.error(`Speaking into call (${voice}): "${text}"`);
  await execFileAsync(AUDIO_SETUP_BIN, ['speak', text, voice]);
}

export async function playFileIntoCall(filePath: string): Promise<void> {
  console.error(`Playing audio file into call: ${filePath}`);
  await execFileAsync(AUDIO_SETUP_BIN, ['play', filePath]);
}

export async function ensureAudioSetup(): Promise<void> {
  await execFileAsync(AUDIO_SETUP_BIN, ['start']);
}
