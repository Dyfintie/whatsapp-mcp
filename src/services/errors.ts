export class ServiceError extends Error {
  constructor(public code: string, message: string, public retryable = false,
    public details: Record<string, unknown> = {}) { super(message); }
}

export async function deadline<T>(promise: Promise<T>, ms: number, code = "TIMEOUT"): Promise<T> {
  let timer: NodeJS.Timeout;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ServiceError(code, "Operation timed out; inspect status before retrying.", false)), ms);
    })]);
  } finally { clearTimeout(timer!); }
}

export function normalizeJid(value: string): string {
  if (/^\+?[1-9]\d{6,14}$/.test(value)) return value.replace(/^\+/, "") + "@s.whatsapp.net";
  if (/^[1-9]\d{6,14}@s\.whatsapp\.net$/.test(value) ||
      /^\d{5,30}(?:-\d{5,20})?@g\.us$/.test(value) || /^\d{5,30}@lid$/.test(value)) return value;
  throw new ServiceError("INVALID_RECIPIENT", "Use an exact phone number with country code or a verified WhatsApp JID. Names and malformed identifiers are not accepted.");
}

export function phoneOf(jid: string): string | null {
  return /^[1-9]\d{6,14}@s\.whatsapp\.net$/.test(jid) ? jid.split("@")[0] : null;
}
