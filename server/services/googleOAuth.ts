import crypto from 'node:crypto';
import { query } from '../db/pool.js';
import { config } from '../config.js';
import type { SessionUser } from '../../shared/domain.js';
import { open, seal } from './secretbox.js';
import { audit } from './audit.js';
import { HttpError } from '../http.js';

// Direct Google connection for YouTube (and Drive, from the same consent). The channel owner
// approves once; the refresh token is stored encrypted and never leaves the server.

// YouTube only: Google refuses YouTube and Drive scopes in one consent. Drive files are read
// through the folder's link share (or a service account), so no Drive scope is needed here.
export const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/youtube', 'https://www.googleapis.com/auth/youtube.upload'];

export function oauthConfigured() {
  return !!(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET);
}

export function publicBaseUrl() {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return `http://localhost:${config.PORT}`;
}
export const redirectUri = () => `${publicBaseUrl()}/api/oauth/google/callback`;

export function authUrl(state: string) {
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    // No include_granted_scopes: merging grants from other clients in this project (e.g. n8n's
    // drive.file) is what triggers "scopes that cannot be requested together".
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

export const newState = () => crypto.randomBytes(24).toString('base64url');

async function tokenRequest(body: Record<string, string>) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!, client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET!, ...body }),
  });
  const json: any = await res.json();
  if (!res.ok) throw new Error(json.error_description ?? json.error ?? `Google token endpoint HTTP ${res.status}`);
  return json as { access_token: string; refresh_token?: string; expires_in: number; scope: string };
}

/** Channels this dashboard may connect: the primary (YOUTUBE_CHANNEL_ID) plus YOUTUBE_EXTRA_CHANNEL_IDS. */
export function allowedChannels() {
  return [process.env.YOUTUBE_CHANNEL_ID, ...(process.env.YOUTUBE_EXTRA_CHANNEL_IDS ?? '').split(',')].map((s) => s?.trim()).filter(Boolean) as string[];
}

/** Exchange the consent code, confirm the channel, and store its tokens. */
export async function completeConsent(code: string, user: SessionUser, via?: string) {
  const t = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectUri() });
  const ch = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
    headers: { authorization: `Bearer ${t.access_token}` },
  }).then((r) => r.json() as Promise<any>);
  const channel = ch.items?.[0];
  if (!channel) throw new HttpError(400, 'That Google account has no YouTube channel. Sign in with the account that owns or manages the channel.');
  const allowed = allowedChannels();
  if (allowed.length && !allowed.includes(channel.id)) {
    throw new HttpError(400, `Connected to channel "${channel.snippet.title}" (${channel.id}), which is not one of this dashboard's channels. Sign in with the account that owns the channel. A YouTube Studio invite (Manager/Editor) does not give apps access; the owner must connect, or add you as a Brand Account manager.`);
  }
  // The primary channel is YOUTUBE_CHANNEL_ID, or the first one connected when none is set.
  const prev = (await query('SELECT channel_id FROM youtube_channels WHERE is_primary')).rows[0];
  const primary = process.env.YOUTUBE_CHANNEL_ID ? channel.id === process.env.YOUTUBE_CHANNEL_ID : !prev;
  // A new main channel takes over the library from the old one (see handOverLibrary).
  if (primary && prev && prev.channel_id !== channel.id) await handOverLibrary(prev.channel_id, user);
  await query(
    `INSERT INTO youtube_channels (channel_id, title, scopes, access_token_enc, refresh_token_enc, expires_at, is_primary, connected_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (channel_id) DO UPDATE SET title = EXCLUDED.title, scopes = EXCLUDED.scopes, access_token_enc = EXCLUDED.access_token_enc,
       refresh_token_enc = COALESCE(EXCLUDED.refresh_token_enc, youtube_channels.refresh_token_enc),
       expires_at = EXCLUDED.expires_at, connected_by = EXCLUDED.connected_by, connected_at = now(), updated_at = now()`,
    [channel.id, channel.snippet.title, t.scope, seal(t.access_token), t.refresh_token ? seal(t.refresh_token) : null, new Date(Date.now() + t.expires_in * 1000), primary, user.id],
  );
  await query(`UPDATE connections SET status = 'connected', last_success_at = now(), last_checked_at = now(), last_error = NULL WHERE key = 'youtube'`);
  await audit({ actor: user, action: 'oauth.google.connect', entityType: 'connection', entityId: 'youtube', next: { channel: channel.snippet.title, channel_id: channel.id, primary, scopes: t.scope }, result: 'success', detail: via ?? null });
  return { channelId: channel.id as string, channelTitle: channel.snippet.title as string };
}

/** Every connected channel, primary first (no tokens). */
export async function youtubeChannels() {
  const { rows } = await query('SELECT channel_id, title, is_primary, connected_at FROM youtube_channels ORDER BY is_primary DESC, title');
  return rows as { channel_id: string; title: string; is_primary: boolean; connected_at: string }[];
}

/** The primary channel's connection (where uploads go), in the shape callers already use. */
export async function googleConnection() {
  const { rows } = await query('SELECT channel_id, title, scopes, expires_at, connected_at, refresh_token_enc IS NOT NULL AS has_refresh FROM youtube_channels WHERE is_primary');
  const r = rows[0];
  return r ? { account_id: r.channel_id, account_name: r.title, scopes: r.scopes, expires_at: r.expires_at, connected_at: r.connected_at, has_refresh: r.has_refresh } : null;
}

/** A valid access token for a channel (the primary when none is given), refreshed when needed. */
export async function googleAccessToken(channelId?: string): Promise<string> {
  const { rows } = channelId
    ? await query('SELECT * FROM youtube_channels WHERE channel_id = $1', [channelId])
    : await query('SELECT * FROM youtube_channels WHERE is_primary');
  const row = rows[0];
  if (!row) throw new HttpError(412, 'YouTube is not connected. An administrator must click "Connect YouTube" on the Connections page.');
  try {
    if (new Date(row.expires_at).getTime() > Date.now() + 60_000) return open(row.access_token_enc);
    if (!row.refresh_token_enc) throw new Error('No refresh token stored; reconnect YouTube.');
    const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: open(row.refresh_token_enc) });
    await query('UPDATE youtube_channels SET access_token_enc = $1, expires_at = $2, updated_at = now() WHERE channel_id = $3', [
      seal(t.access_token), new Date(Date.now() + t.expires_in * 1000), row.channel_id,
    ]);
    return t.access_token;
  } catch (e) {
    const msg = `Google authorization failed for "${row.title}": ${(e as Error).message}. Reconnect YouTube on the Connections page.`;
    if (row.is_primary) await query(`UPDATE connections SET status = 'disconnected', last_error = $1, last_error_at = now(), automation_enabled = false WHERE key IN ('youtube','google_drive')`, [msg]);
    throw new HttpError(412, msg);
  }
}

/** Disconnect one channel (the primary when none is given). */
export async function disconnectGoogle(user: SessionUser, channelId?: string) {
  const { rows } = channelId
    ? await query('SELECT * FROM youtube_channels WHERE channel_id = $1', [channelId])
    : await query('SELECT * FROM youtube_channels WHERE is_primary');
  const row = rows[0];
  if (!row) return;
  // Best effort: revoke at Google so the grant disappears from the owner's account too.
  try {
    const tok = open(row.refresh_token_enc ?? row.access_token_enc);
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tok)}`, { method: 'POST' });
  } catch {}
  await query('DELETE FROM youtube_channels WHERE channel_id = $1', [row.channel_id]);
  if (row.is_primary) {
    await query(`UPDATE connections SET status = 'not_configured', automation_enabled = false, automation_changed_by = $1, automation_changed_at = now() WHERE key IN ('youtube','google_drive')`, [user.id]);
  }
  await audit({ actor: user, action: 'oauth.google.disconnect', entityType: 'connection', entityId: 'youtube', result: 'success', detail: row.title });
}
// ---------- One-time connect links ----------
// The channel owner may not have (or want) a dashboard login. An administrator creates a link,
// sends it to the owner, and the owner approves Google's consent screen from it. The link works
// once, expires after a day, and only a hash of it is stored.

const INVITE_HOURS = 24;
const hashToken = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

export async function createConnectInvite(user: SessionUser) {
  if (!oauthConfigured()) throw new HttpError(412, 'Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in Railway first.');
  // Only the newest link works.
  await query(`UPDATE connect_invites SET revoked_at = now(), result = 'Replaced by a newer link' WHERE provider = 'google' AND used_at IS NULL AND revoked_at IS NULL`);
  const token = crypto.randomBytes(32).toString('base64url');
  const { rows } = await query(
    `INSERT INTO connect_invites (provider, token_hash, created_by, expires_at) VALUES ('google', $1, $2, now() + make_interval(hours => $3)) RETURNING id, expires_at`,
    [hashToken(token), user.id, INVITE_HOURS],
  );
  await audit({ actor: user, action: 'oauth.google.invite', entityType: 'connection', entityId: 'youtube', next: { invite_id: rows[0].id, expires_at: rows[0].expires_at }, result: 'success' });
  return { url: `${publicBaseUrl()}/api/connect/youtube/${token}`, expires_at: rows[0].expires_at as string };
}

/** The link's invite id when it is still usable (and note that it was opened). */
export async function openConnectInvite(token: string) {
  if (!/^[A-Za-z0-9_-]{30,60}$/.test(token)) return null;
  const { rows } = await query(
    `UPDATE connect_invites SET opened_at = COALESCE(opened_at, now())
      WHERE token_hash = $1 AND provider = 'google' AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()
      RETURNING id`,
    [hashToken(token)],
  );
  return (rows[0]?.id as string | undefined) ?? null;
}

/** For the OAuth callback: the invite if still usable, with the administrator who created it. */
export async function inviteForCallback(inviteId: string) {
  const { rows } = await query(
    `SELECT i.id, u.id AS user_id, u.email, u.name, u.role FROM connect_invites i JOIN users u ON u.id = i.created_by
      WHERE i.id = $1 AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now() AND u.active`,
    [inviteId],
  );
  const r = rows[0];
  return r ? { id: r.id as string, creator: { id: r.user_id, email: r.email, name: r.name, role: r.role } as SessionUser } : null;
}

export async function finishConnectInvite(inviteId: string, ok: boolean, result: string) {
  await query(`UPDATE connect_invites SET used_at = CASE WHEN $2 THEN now() ELSE used_at END, result = $3 WHERE id = $1`, [inviteId, ok, result]);
}

export async function currentConnectInvite() {
  const { rows } = await query(
    `SELECT i.created_at, i.expires_at, i.opened_at, i.result, u.name AS created_by FROM connect_invites i JOIN users u ON u.id = i.created_by
      WHERE i.provider = 'google' AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
      ORDER BY i.created_at DESC LIMIT 1`,
  );
  return rows[0] ?? null;
}

export async function revokeConnectInvites(user: SessionUser) {
  const r = await query(`UPDATE connect_invites SET revoked_at = now(), result = 'Revoked' WHERE provider = 'google' AND used_at IS NULL AND revoked_at IS NULL`);
  await audit({ actor: user, action: 'oauth.google.invite_revoke', entityType: 'connection', entityId: 'youtube', result: 'success', detail: `${r.rowCount} link(s) revoked` });
}
/**
 * The main channel is changing: keep the library's links to the old channel's videos in
 * youtube_copies (those videos stay on YouTube, untouched), clear them from the library so the same
 * videos can be uploaded to the new channel, and forget the old channel's playlists.
 */
export async function handOverLibrary(oldChannelId: string, user: SessionUser) {
  const { tx } = await import('../db/pool.js');
  const moved = await tx(async (client) => {
    const r = await client.query(
      `INSERT INTO youtube_copies (youtube_video_id, channel_id, video_id, title, url, status, privacy, publish_at, views)
       SELECT youtube_video_id, $1, id, youtube_title, youtube_url, youtube_status, youtube_privacy, youtube_publish_at, youtube_views
         FROM videos WHERE youtube_video_id IS NOT NULL
       ON CONFLICT (youtube_video_id) DO NOTHING`,
      [oldChannelId],
    );
    await client.query(
      `UPDATE videos SET youtube_video_id = NULL, youtube_url = NULL, youtube_status = 'not_uploaded', youtube_privacy = NULL,
         youtube_publish_at = NULL, youtube_title = NULL, youtube_views = NULL, youtube_synced_at = NULL, youtube_upload_status = NULL, updated_at = now()
       WHERE youtube_video_id IS NOT NULL`,
    );
    await client.query('DELETE FROM youtube_playlist_items');
    await client.query('DELETE FROM youtube_playlists');
    await client.query('UPDATE youtube_channels SET is_primary = false WHERE channel_id = $1', [oldChannelId]);
    return r.rowCount ?? 0;
  });
  await audit({ actor: user, action: 'youtube.main_channel_change', entityType: 'connection', entityId: 'youtube', previous: { main_channel: oldChannelId }, result: 'success', detail: `${moved} video link(s) kept as copies on the old channel` });
  return moved;
}

/** Make an already-connected channel the main one (uploads and the library go there). */
export async function makeMainChannel(channelId: string, user: SessionUser) {
  const { rows } = await query('SELECT channel_id, is_primary FROM youtube_channels WHERE channel_id = $1', [channelId]);
  if (!rows[0]) throw new HttpError(404, 'That channel is not connected.');
  if (rows[0].is_primary) return;
  const prev = (await query('SELECT channel_id FROM youtube_channels WHERE is_primary')).rows[0];
  if (prev) await handOverLibrary(prev.channel_id, user);
  await query('UPDATE youtube_channels SET is_primary = true WHERE channel_id = $1', [channelId]);
}