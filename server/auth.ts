import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { NextFunction, Request, Response } from 'express';
import { query } from './db/pool.js';
import { config, isProd } from './config.js';
import type { Role, SessionUser } from '../shared/domain.js';
import { can, type Permission } from '../shared/permissions.js';
import { audit } from './services/audit.js';

export const SESSION_COOKIE = 'cos_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser', 12);

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

const hashToken = (t: string) => crypto.createHmac('sha256', config.SESSION_SECRET).update(t).digest('hex');

export async function hashPassword(pw: string) {
  return bcrypt.hash(pw.trim(), 12);
}

/**
 * Returns the ids of users (other than `exceptId`) whose password equals `password`.
 * Sign-in is password-only, so passwords must be unique across users.
 */
export async function usersWithPassword(password: string, exceptId?: string) {
  const { rows } = await query('SELECT id, password_hash FROM users WHERE id IS DISTINCT FROM $1', [exceptId ?? null]);
  const hits: string[] = [];
  for (const r of rows) if (await bcrypt.compare(password.trim(), r.password_hash)) hits.push(r.id);
  return hits;
}

// Simple in-memory limiter: password-only sign-in has no username step to slow guessing.
const attempts = new Map<string, { n: number; until: number }>();
/** True when this client has had 10+ failed sign-ins in the last 15 minutes. */
export function loginRateLimited(key: string) {
  const a = attempts.get(key);
  return !!a && a.until > Date.now() && a.n >= 10;
}
export function recordLoginFailure(key: string) {
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || a.until < now) attempts.set(key, { n: 1, until: now + 15 * 60_000 });
  else a.n++;
}
export function clearLoginFailures(key: string) {
  attempts.delete(key);
}

/** Password-only sign-in: the password identifies the user. */
export async function login(rawPassword: string, res: Response) {
  // Copy-pasted credentials often carry stray whitespace; stored passwords are trimmed too.
  const password = rawPassword.trim();
  const { rows } = await query('SELECT id, email, name, role, password_hash FROM users WHERE active');
  let u: any = null;
  for (const r of rows) {
    if (await bcrypt.compare(password, r.password_hash)) {
      u = r;
      break;
    }
  }
  if (!rows.length) await bcrypt.compare(password, DUMMY_HASH);
  if (!u) {
    await audit({ actor: null, action: 'auth.login', entityType: 'user', result: 'denied', detail: 'Invalid password' });
    return null;
  }
  const token = crypto.randomBytes(32).toString('base64url');
  await query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [
    hashToken(token),
    u.id,
    new Date(Date.now() + SESSION_TTL_MS),
  ]);
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [u.id]);
  await query('DELETE FROM sessions WHERE expires_at < now()');
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd,
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
  const user: SessionUser = { id: u.id, email: u.email, name: u.name, role: u.role };
  await audit({ actor: user, action: 'auth.login', entityType: 'user', entityId: u.id, result: 'success' });
  return user;
}

export async function logout(req: Request, res: Response) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) await query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

export async function sessionMiddleware(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return next();
  try {
    const { rows } = await query(
      `SELECT u.id, u.email, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active`,
      [hashToken(token)],
    );
    if (rows[0]) req.user = rows[0] as SessionUser;
    next();
  } catch (e) {
    next(e);
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: 'Sign in required.' });
  next();
}

export function requirePermission(permission: Permission) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in required.' });
    if (!can(req.user.role as Role, permission)) {
      await audit({
        actor: req.user,
        action: `denied:${permission}`,
        entityType: 'permission',
        entityId: req.originalUrl,
        result: 'denied',
        detail: `Role ${req.user.role} lacks ${permission}`,
      });
      return res.status(403).json({ error: `Your role does not allow this action (${permission}).` });
    }
    next();
  };
}
