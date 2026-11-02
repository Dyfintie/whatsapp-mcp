import { readFileSync, statSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';

// A private local credential, never a query parameter or a logged value.
export function readApiToken(): string {
  const file = process.env.WHATSAPP_API_TOKEN_FILE;
  if (!file) throw new Error('WHATSAPP_API_TOKEN_FILE must point to a private token file.');
  const stat = statSync(file);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0)
    throw new Error('API token must be a regular file accessible only by its owner.');
  const token = readFileSync(file, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('API token must contain 32 random bytes encoded as 64 lowercase hex characters.');
  return token;
}
export function authorized(header: string | undefined, token: string): boolean {
  const supplied = Buffer.from(header || '');
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
