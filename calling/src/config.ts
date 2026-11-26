import path from 'path';
import os from 'os';

export const CONFIG = {
  userDataDir: path.join(os.homedir(), '.config', 'whatsapp-web-calling'),
  executablePath: process.env.WHATSAPP_CHROMIUM_BIN || '/usr/sbin/chromium',
  virtualSink: 'WhatsAppVirtualSink',
  virtualSource: 'WhatsAppVirtualMic',
  defaultTimeout: 30000,
  chatUrlPrefix: 'https://web.whatsapp.com/send?phone=',
  homeUrl: 'https://web.whatsapp.com',
};
