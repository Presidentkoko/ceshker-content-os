import crypto from 'node:crypto';
import { config } from '../config.js';

// AES-256-GCM for OAuth tokens at rest. Key: TOKEN_ENCRYPTION_KEY if set, else derived from SESSION_SECRET.
const key = crypto.createHash('sha256').update(process.env.TOKEN_ENCRYPTION_KEY || `tokens:${config.SESSION_SECRET}`).digest();

export function seal(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}

export function open(sealed: string): string {
  const [iv, tag, enc] = sealed.split('.').map((s) => Buffer.from(s, 'base64url'));
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
