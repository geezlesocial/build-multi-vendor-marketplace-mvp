import crypto from 'node:crypto';
import { env } from './config.js';

export const CJ_API_ROOT = 'https://developers.cjdropshipping.com/api2.0/v1';
export const CJ_PROVIDER = 'CJ_DROPSHIPPING';

export type CjCredentials = {
  apiKey: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
};

function encryptionKey() {
  if (env.DROPSHIPPING_ENCRYPTION_KEY) return crypto.createHash('sha256').update(env.DROPSHIPPING_ENCRYPTION_KEY).digest();
  if (env.NODE_ENV === 'production') throw Object.assign(new Error('Dropshipping credential encryption is not configured.'), { statusCode: 503 });
  return crypto.createHash('sha256').update(`${env.PASSWORD_PEPPER}:local-dropshipping-key`).digest();
}

export function encryptDropshippingCredentials(value: CjCredentials) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map(part => part.toString('base64url')).join('.');
}

export function decryptDropshippingCredentials(value: string): CjCredentials {
  const [ivText, tagText, ciphertextText] = value.split('.');
  if (!ivText || !tagText || !ciphertextText) throw new Error('Stored supplier credentials are invalid. Reconnect this supplier.');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivText, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    const credentials = JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertextText, 'base64url')), decipher.final()]).toString('utf8')) as CjCredentials;
    if (!credentials.apiKey || !credentials.accessToken || !credentials.refreshToken) throw new Error('missing fields');
    return credentials;
  } catch {
    throw new Error('Stored supplier credentials could not be decrypted. Reconnect this supplier.');
  }
}

export function validCjResponse(value: unknown): value is { code: number; result?: boolean; success?: boolean; message?: string; data?: unknown } {
  if (!value || typeof value !== 'object') return false;
  const response = value as Record<string, unknown>;
  return Number.isInteger(response.code) && (response.result === undefined || typeof response.result === 'boolean') && (response.success === undefined || typeof response.success === 'boolean');
}

export function cjCallSucceeded(response: { code: number; result?: boolean; success?: boolean }) {
  return (response.code === 0 || response.code === 200) && response.result !== false && response.success !== false;
}

export function safeCjImageUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2000) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    if (!(host === 'cjdropshipping.com' || host.endsWith('.cjdropshipping.com') || host === 'aliyuncs.com' || host.endsWith('.aliyuncs.com'))) return null;
    return url.toString();
  } catch { return null; }
}

export function cleanSupplierDescription(value: unknown) {
  if (typeof value !== 'string') return '';
  return value.replace(/<\s*(script|style)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'").replace(/\s+/g, ' ').trim().slice(0, 5000);
}

export function supplierProductList(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') return [];
  const data = value as Record<string, unknown>;
  const content = Array.isArray(data.content) ? data.content : [];
  const items = content.flatMap((entry) => entry && typeof entry === 'object' && Array.isArray((entry as Record<string, unknown>).productList)
    ? (entry as Record<string, unknown>).productList as unknown[] : []);
  return items.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item));
}
