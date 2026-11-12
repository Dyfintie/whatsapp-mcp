import path from 'path';
import os from 'os';

export const CONFIG = {
  cdpPort: 9222,
  cdpUrl: 'http://127.0.0.1:9222',
  userDataDir: path.join(os.homedir(), '.config', 'whatsapp-web-calling'),
  executablePath: '/usr/sbin/chromium',
  virtualSink: 'WhatsAppVirtualSink',
  virtualSource: 'WhatsAppVirtualMic',
  defaultTimeout: 30000,
  chatUrlPrefix: 'https://web.whatsapp.com/send?phone=',
  homeUrl: 'https://web.whatsapp.com',
};
