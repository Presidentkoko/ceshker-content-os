import { brand } from './brand.js';
import { publicBrand } from '../shared/brand.js';
import express, { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { h, HttpError, parse } from './http.js';
import {
  clearLoginFailures, hashPassword, login, loginRateLimited, logout, recordLoginFailure, requireAuth, requirePermission, usersWithPassword,
} from './auth.js';
import { query } from './db/pool.js';
import { config } from './config.js';
import {
  APPROVAL_STATUSES, CONNECTION_KEYS, CONTENT_TYPES, PLACEMENTS, PLATFORM_PLACEMENTS, PLATFORMS,
  PUBLISH_STATUSES, ROLES, YOUTUBE_STATUSES, type ConnectionKey,
} from '../shared/domain.js';
import {
  addAsset, assetFile, createContent, duplicateContent, getContentDetail, importAsset, listContent, removeAsset, setArchived, transition, uploadAsset,
  updateAsset, updateContent,
} from './services/content.js';
import { cancelQueueItem, completePublication, dryRun, enqueue, recordManualPublication, reschedule, retry, setPaused } from './services/queue.js';
import { listConnections, setAutomation, testConnection } from './services/connections.js';
import { syncSheet } from './services/sheetSync.js';
import { createDerivative, createVideo, DERIVATIVES, getVideo, listVideos, mergeYoutubeRecord, setVideoArchived, syncDrive, updateVideo } from './services/library.js';
import { analytics, notifications, overview } from './services/insights.js';
import { audit } from './services/audit.js';
import {
  authUrl, completeConsent, createConnectInvite, disconnectGoogle, finishConnectInvite, googleConnection, inviteForCallback, newState, oauthConfigured,
  makeMainChannel, openConnectInvite, revokeConnectInvites, youtubeChannels,
} from './services/googleOAuth.js';
import { can } from '../shared/permissions.js';
import { channelSummary, ensurePlaylists, pushVideo, startUpload, syncChannel, youtubePerformance } from './services/youtube.js';
import { metaPages, metaPerformance, metaTokenConfigured, privateTest, syncPages, updatePage } from './services/meta.js';
import {
  canvaAuthStart, canvaConfigured, completeCanvaConsent, disconnectCanva, FIELD_SOURCES, generateForContent, getRule, guessSource,
  listTemplates, ruleCandidates, runCanvaAutomation, setRule, templateDataset, type FieldSource,
  autoGenerate, bulkCandidates, bulkStatus, graphicsOverview, startBulkGenerate,
} from './services/canva.js';
import {
  canvaMcpAuthStart, canvaMcpConnection, describeTools, inspectDesign, canvaMcpProbe, checkAsset, checkRecentAssets, completeCanvaMcpConsent, disconnectCanvaMcp, fixAssetLogo, getBrandRules, parsePastedRedirect, setBrandRules,
} from './services/canvaMcp.js';

export const api = Router();

const uuid = z.string().uuid();
const optStr = z.string().trim().max(10_000).nullish().transform((v) => (v === '' ? null : v));
const isoDate = z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Invalid date/time').nullish();
const targets = z
  .array(z.object({ platform: z.enum(PLATFORMS), placement: z.enum(PLACEMENTS), account_id: z.string().regex(/^\d{5,30}$/).nullish() }))
  .refine((ts) => ts.every((t) => PLATFORM_PLACEMENTS[t.platform].includes(t.placement)), 'Placement is not valid for that platform');
const timezone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'Unknown time zone');

const contentBody = z.object({
  title: z.string().trim().min(1, 'Title is required').max(300),
  caption: optStr,
  description: optStr,
  cta: optStr,
  hashtags: optStr,
  notes: optStr,
  category: z.string().refine((c) => brand.categories.includes(c), 'Unknown category for this brand.'),
  priority: z.coerce.number().int().min(1).max(3).nullish(),
  content_type: z.enum(CONTENT_TYPES),
  campaign_id: uuid.nullish(),
  video_id: uuid.nullish(),
  parent_id: uuid.nullish(),
  scheduled_at: isoDate,
  timezone: timezone.default(config.APP_TIMEZONE),
  targets: targets.optional(),
});
const versioned = z.object({ version: z.number().int().positive() });

// ---------- Auth ----------

api.post('/auth/login', h(async (req, res) => {
  const body = parse(z.object({ password: z.string().min(1).max(200) }), req.body);
const key = req.ip ?? 'unknown';
  if (loginRateLimited(key)) throw new HttpError(429, 'Too many failed sign-in attempts. Wait 15 minutes and try again.');
  const user = await login(body.password, res);
  if (!user) {
    recordLoginFailure(key);
    throw new HttpError(401, 'Password is incorrect.');
  }
  clearLoginFailures(key);
  res.json({ user });
}));
api.post('/auth/logout', h(async (req, res) => {
  await logout(req, res);
  res.json({ ok: true });
}));
api.get('/auth/me', (req, res) => res.json({ user: req.user ?? null }));

// n8n callback: authenticated by shared secret, not by a user session.
api.post('/hooks/n8n/publish-result', h(async (req, res) => {
  const secret = req.get('x-contentos-callback-secret') ?? '';
  const expected = config.N8N_CALLBACK_SECRET ?? '';
  const ok = expected.length > 0 && secret.length === expected.length && crypto.timingSafeEqual(Buffer.from(secret), Buffer.from(expected));
  if (!ok) throw new HttpError(401, 'Invalid callback secret.');
  const body = parse(
    z.object({ run_id: uuid, ok: z.boolean(), platform_post_id: z.string().nullish(), public_url: z.string().url().nullish(), error: z.string().nullish(), execution_id: z.string().nullish() }),
    req.body,
  );
  res.json(await completePublication(body));
}));

// ---------- YouTube consent (public: the channel owner may have no dashboard login) ----------

const OAUTH_STATE_COOKIE = 'cos_oauth_state';

/** A small standalone page for people who arrive from a connect link. */
function notice(res: express.Response, status: number, title: string, body: string) {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  res.status(status).type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#0b1a30;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}main{max-width:460px;background:#10233f;border:1px solid #cfaa6b;border-radius:12px;padding:28px}h1{font-size:22px;margin:0 0 8px;color:#cfaa6b}p{margin:0;color:#dfe6f0}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(body)}</p></main></body></html>`);
}

api.get('/connect/youtube/:token', h(async (req, res) => {
  if (!oauthConfigured()) return notice(res, 503, 'YouTube connection is not set up yet', 'Please let the Content OS administrator know.');
  const inviteId = await openConnectInvite(String(req.params.token));
  if (!inviteId) return notice(res, 410, 'This link has expired', 'Connect links work once and expire after 24 hours. Ask the Content OS administrator for a new one.');
  const state = newState();
  res.cookie(OAUTH_STATE_COOKIE, `inv.${inviteId}.${state}`, { httpOnly: true, sameSite: 'lax', secure: config.NODE_ENV === 'production', maxAge: 15 * 60_000, path: '/api/oauth' });
  res.redirect(authUrl(state));
}));

api.get('/oauth/google/callback', h(async (req, res) => {
  const raw = String(req.cookies?.[OAUTH_STATE_COOKIE] ?? '');
  res.clearCookie(OAUTH_STATE_COOKIE, { path: '/api/oauth' });
  const invite = raw.match(/^inv\.([0-9a-f-]{36})\.(.+)$/);
  if (invite) {
    // Arrived from a connect link: answer with a plain page, not the dashboard.
    const [, inviteId, state] = invite;
    if (req.query.error) return notice(res, 400, 'YouTube was not connected', `Google reported: ${String(req.query.error)}. You can open the link again to retry.`);
    if (state !== req.query.state) return notice(res, 400, 'Sign-in session expired', 'Open the connect link again to retry.');
    const inv = await inviteForCallback(inviteId);
    if (!inv) return notice(res, 410, 'This link has expired', 'Ask the Content OS administrator for a new one.');
    try {
      const r = await completeConsent(String(req.query.code ?? ''), inv.creator, 'Approved by the channel owner through a connect link');
      await finishConnectInvite(inviteId, true, `Connected ${r.channelTitle}`);
      return notice(res, 200, 'YouTube connected', `Thank you. The Content OS dashboard can now manage “${r.channelTitle}”. You can close this tab.`);
    } catch (e) {
      const msg = (e as Error).message;
      await finishConnectInvite(inviteId, false, msg);
      await audit({ actor: inv.creator, action: 'oauth.google.connect', entityType: 'connection', entityId: 'youtube', result: 'failure', detail: `Connect link: ${msg}` });
      return notice(res, 400, 'YouTube was not connected', msg);
    }
  }
  // Signed-in administrator flow from the Connections page.
  if (!req.user) throw new HttpError(401, 'Sign in required.');
  if (!can(req.user.role, 'connections.automation')) throw new HttpError(403, 'Only administrators can connect YouTube.');
  const back = (q: string) => res.redirect(`/connections?${q}`);
  if (req.query.error) return back(`youtube_error=${encodeURIComponent(String(req.query.error))}`);
  if (!raw || raw !== req.query.state) return back('youtube_error=' + encodeURIComponent('Sign-in session expired or did not match. Try Connect YouTube again.'));
  try {
    const r = await completeConsent(String(req.query.code ?? ''), req.user);
    back(`youtube=connected&channel=${encodeURIComponent(r.channelTitle)}`);
  } catch (e) {
    await audit({ actor: req.user, action: 'oauth.google.connect', entityType: 'connection', entityId: 'youtube', result: 'failure', detail: (e as Error).message });
    back(`youtube_error=${encodeURIComponent((e as Error).message)}`);
  }
}));

// Brand identity for the sign-in screen (no secrets).
api.get('/brand', (_req, res) => res.json(publicBrand(brand)));

api.use(requireAuth);

// ---------- Overview / analytics ----------

api.get('/overview', h(async (_req, res) => res.json(await overview())));
api.get('/analytics', h(async (_req, res) => res.json(await analytics())));
api.get('/notifications', h(async (req, res) => res.json(await notifications(req.user!.role))));
api.get('/meta', h(async (_req, res) => {
  const campaigns = await query('SELECT id, name, slug FROM campaigns ORDER BY name');
  const pages = await metaPages(true);
  res.json({
    timezone: config.APP_TIMEZONE,
    categories: brand.categories,
    brand: publicBrand(brand),
    canva_configured: canvaConfigured(),
    content_types: CONTENT_TYPES,
    platforms: PLATFORMS,
    platform_placements: PLATFORM_PLACEMENTS,
    campaigns: campaigns.rows,
    derivatives: DERIVATIVES.map(({ kind, label }) => ({ kind, label })),
    // Publishing accounts for the destination picker (no tokens, just ids and names).
    meta_pages: pages.map((p) => ({ page_id: p.page_id, name: p.name, ig_user_id: p.ig_user_id, ig_username: p.ig_username, is_default: p.is_default })),
    sheet_url: config.GOOGLE_SHEET_ID ? `https://docs.google.com/spreadsheets/d/${config.GOOGLE_SHEET_ID}/edit#gid=${config.GOOGLE_SHEET_GID}` : null,
  });
}));

// ---------- Content ----------

const listQuery = z.object({
  q: z.string().trim().max(200).optional(),
  campaign_id: uuid.optional(),
  platform: z.enum(PLATFORMS).optional(),
  category: z.string().max(60).optional(),
  priority: z.coerce.number().int().min(1).max(3).optional(),
  approval_status: z.enum(APPROVAL_STATUSES).optional(),
  publish_status: z.enum(PUBLISH_STATUSES).optional(),
  readiness: z.enum(['ready', 'needs_attention', 'blocked']).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  archived: z.enum(['exclude', 'only', 'include']).optional(),
  video_id: uuid.optional(),
  missing_assets: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
  needs_details: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
  page: z.coerce.number().int().min(1).optional(),
  page_size: z.coerce.number().int().min(1).max(500).optional(),
  sort: z.enum(['scheduled_at', 'title', 'updated_at', 'priority', 'ref', 'category']).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
});

api.get('/content', h(async (req, res) => {
  const { page, page_size, sort, dir, ...f } = parse(listQuery, req.query);
  res.json(await listContent(f, { page, pageSize: page_size ?? 25, sort, dir }));
}));

api.get('/content/export.csv', requirePermission('content.export'), h(async (req, res) => {
  const { page: _p, page_size: _s, sort, dir, ...f } = parse(listQuery, req.query);
  const { items } = await listContent(f, { pageSize: 5000, sort, dir });
  const cols = ['ref', 'title', 'category', 'priority', 'content_type', 'campaign_name', 'scheduled_at', 'timezone', 'approval_status', 'publish_status', 'readiness', 'platforms', 'caption', 'hashtags', 'cta', 'notes', 'issues'];
  const esc = (v: unknown) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@]/.test(s)) s = `'${s}`; // neutralise spreadsheet formula injection
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(',')];
  for (const i of items) {
    const row: Record<string, unknown> = {
      ...i,
      platforms: i.targets.map((t) => `${t.platform}:${t.placement}`).join(' '),
      issues: i.issues.map((x) => x.message).join(' | '),
    };
    lines.push(cols.map((c) => esc(row[c])).join(','));
  }
  await audit({ actor: req.user!, action: 'content.export', entityType: 'content', result: 'success', detail: `${items.length} rows`, next: f });
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="content-export-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('﻿' + lines.join('\r\n'));
}));

api.get('/content/:id', h(async (req, res) => res.json(await getContentDetail(parse(uuid, req.params.id)))));

api.post('/content', requirePermission('content.edit'), h(async (req, res) => {
  const body = parse(contentBody, req.body);
  res.status(201).json(await createContent(body, req.user!));
}));

api.patch('/content/:id', requirePermission('content.edit'), h(async (req, res) => {
  const body = parse(contentBody.partial().merge(versioned), req.body);
  const { version, ...patch } = body;
  res.json(await updateContent(parse(uuid, req.params.id), patch as any, version, req.user!));
}));

api.post('/content/:id/duplicate', requirePermission('content.edit'), h(async (req, res) => {
  res.status(201).json(await duplicateContent(parse(uuid, req.params.id), req.user!));
}));

api.post('/content/:id/archive', requirePermission('content.archive'), h(async (req, res) => {
  const { archived } = parse(z.object({ archived: z.boolean() }), req.body);
  res.json(await setArchived(parse(uuid, req.params.id), archived, req.user!));
}));

const transitionBody = versioned.extend({ comment: z.string().trim().max(2000).nullish() });
api.post('/content/:id/submit', requirePermission('content.submit'), h(async (req, res) => {
  const b = parse(transitionBody, req.body);
  res.json(await transition(parse(uuid, req.params.id), 'submit', b.comment ?? null, b.version, req.user!));
}));
for (const t of ['approve', 'reject', 'request_revision'] as const) {
  api.post(`/content/:id/${t.replace('_', '-')}`, requirePermission('content.approve'), h(async (req, res) => {
    const b = parse(transitionBody, req.body);
    res.json(await transition(parse(uuid, req.params.id), t, b.comment ?? null, b.version, req.user!));
  }));
}

api.post('/content/:id/reschedule', requirePermission('queue.manage'), h(async (req, res) => {
  const b = parse(versioned.extend({ scheduled_at: z.string().datetime({ offset: true }) }), req.body);
  await reschedule(parse(uuid, req.params.id), b.scheduled_at, b.version, req.user!);
  res.json(await getContentDetail(req.params.id));
}));

api.post('/content/:id/validate', h(async (req, res) => {
  const d = await getContentDetail(parse(uuid, req.params.id));
  await query(
    `INSERT INTO workflow_runs (kind, content_id, status, summary, triggered_by, response, finished_at)
     VALUES ('validation', $1, $2, $3, $4, $5, now())`,
    [d.item.id, d.item.readiness === 'blocked' ? 'failed' : 'succeeded', `Validate ${d.item.ref}`, req.user!.id, JSON.stringify({ issues: d.item.issues })],
  );
  res.json({ readiness: d.item.readiness, issues: d.item.issues });
}));

api.post('/content/:id/queue', requirePermission('queue.manage'), h(async (req, res) => {
  const b = parse(versioned, req.body);
  res.json(await enqueue(parse(uuid, req.params.id), b.version, req.user!));
}));

api.post('/content/:id/dry-run', requirePermission('queue.dry_run'), h(async (req, res) => {
  res.json(await dryRun(parse(uuid, req.params.id), req.user!));
}));

api.post('/content/:id/publications', requirePermission('queue.manage'), h(async (req, res) => {
  const b = parse(
    z.object({ target_id: uuid, public_url: z.string().url().nullish(), platform_post_id: z.string().max(200).nullish(), published_at: isoDate }),
    req.body,
  );
  await recordManualPublication(parse(uuid, req.params.id), b, req.user!);
  res.json(await getContentDetail(req.params.id));
}));

api.post('/content/:id/assets', requirePermission('content.edit'), h(async (req, res) => {
  const b = parse(
    z.object({ kind: z.enum(['image', 'video', 'thumbnail', 'document', 'link']), url: z.string().url().max(2000), label: optStr, approved: z.boolean().optional() }),
    req.body,
  );
  // Only approvers/admins may mark media approved on creation.
  const canApprove = ['admin', 'approver'].includes(req.user!.role);
  res.status(201).json(await addAsset(parse(uuid, req.params.id), { ...b, approved: canApprove && !!b.approved }, req.user!));
}));
api.post('/content/:id/assets/import', requirePermission('content.edit'), h(async (req, res) => {
  const b = parse(z.object({ url: z.string().url().max(4000), label: optStr, approved: z.boolean().optional() }), req.body);
  const canApprove = ['admin', 'approver'].includes(req.user!.role);
  res.status(201).json(await importAsset(parse(uuid, req.params.id), { ...b, approved: canApprove && !!b.approved }, req.user!));
}));
// Upload from the user's computer: the request body is the raw image file.
api.post(
  '/content/:id/assets/upload',
  requirePermission('content.edit'),
  express.raw({ type: ['image/*', 'application/octet-stream'], limit: '21mb' }),
  h(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'No file received.');
    const canApprove = ['admin', 'approver'].includes(req.user!.role);
    const filename = decodeURIComponent(String(req.get('x-filename') ?? 'image'));
    const label = req.get('x-label') ? decodeURIComponent(String(req.get('x-label'))) : null;
    res.status(201).json(await uploadAsset(parse(uuid, req.params.id), req.body, { filename, label, approved: canApprove && req.get('x-approved') === 'true' }, req.user!));
  }),
);
// Preview of a stored image for signed-in users.
api.get('/assets/:id/file', h(async (req, res) => {
  const f = await assetFile(parse(uuid, req.params.id));
  res.setHeader('content-type', f.mime);
  res.setHeader('cache-control', 'private, max-age=3600');
  res.send(f.data);
}));
api.patch('/assets/:id', h(async (req, res) => {
  const b = parse(z.object({ approved: z.boolean().optional(), label: optStr }), req.body);
  const role = req.user!.role;
  if (b.approved !== undefined && !['admin', 'approver'].includes(role)) throw new HttpError(403, 'Only approvers can approve assets.');
  if (b.label !== undefined && !['admin', 'content_manager'].includes(role)) throw new HttpError(403, 'Your role cannot edit assets.');
  await updateAsset(parse(uuid, req.params.id), b, req.user!);
  res.json({ ok: true });
}));
api.delete('/assets/:id', requirePermission('content.edit'), h(async (req, res) => {
  await removeAsset(parse(uuid, req.params.id), req.user!);
  res.json({ ok: true });
}));

// ---------- Queue ----------

api.get('/queue', h(async (req, res) => {
  const { state } = parse(z.object({ state: z.enum(['live', 'history', 'failed']).default('live') }), req.query);
  const states = state === 'live' ? ['scheduled', 'paused', 'dispatching'] : state === 'failed' ? ['failed'] : ['published', 'cancelled'];
  const { rows } = await query(
    `SELECT q.*, c.ref, c.title, c.category, c.approval_status, c.version AS content_version_now, t.platform, t.placement,
       p.public_url, p.platform_post_id, p.method AS publication_method
     FROM queue_items q JOIN content_items c ON c.id = q.content_id JOIN content_targets t ON t.id = q.target_id
     LEFT JOIN publications p ON p.target_id = q.target_id
     WHERE q.state = ANY($1) ORDER BY ${state === 'history' ? 'q.updated_at DESC' : 'q.run_at ASC'} LIMIT 300`,
    [states],
  );
  res.json(rows);
}));
api.post('/queue/:id/pause', requirePermission('queue.manage'), h(async (req, res) => {
  await setPaused(parse(uuid, req.params.id), true, req.user!);
  res.json({ ok: true });
}));
api.post('/queue/:id/resume', requirePermission('queue.manage'), h(async (req, res) => {
  await setPaused(parse(uuid, req.params.id), false, req.user!);
  res.json({ ok: true });
}));
api.post('/queue/:id/cancel', requirePermission('queue.manage'), h(async (req, res) => {
  await cancelQueueItem(parse(uuid, req.params.id), req.user!);
  res.json({ ok: true });
}));
api.post('/queue/:id/retry', requirePermission('queue.retry'), h(async (req, res) => {
  await retry(parse(uuid, req.params.id), req.user!);
  res.json({ ok: true });
}));
api.get('/publications', h(async (_req, res) => {
  const { rows } = await query(
    `SELECT p.*, c.ref, c.title, t.placement FROM publications p JOIN content_items c ON c.id = p.content_id
     JOIN content_targets t ON t.id = p.target_id ORDER BY p.published_at DESC LIMIT 300`,
  );
  res.json(rows);
}));

// ---------- Videos ----------

const videoBody = z.object({
  title: z.string().trim().min(1).max(300),
  public_title: optStr,
  description: optStr,
  series_no: z.coerce.number().int().min(1).max(999).nullish(),
  playlist: optStr,
  drive_url: z.string().url().nullish().or(z.literal('').transform(() => null)),
  thumbnail_url: z.string().url().nullish().or(z.literal('').transform(() => null)),
  release_at: isoDate,
  campaign_id: uuid.nullish(),
  notes: optStr,
  youtube_status: z.enum(YOUTUBE_STATUSES).optional(),
  youtube_url: z.string().url().nullish().or(z.literal('').transform(() => null)),
});
api.get('/videos', h(async (req, res) => {
  const f = parse(z.object({ q: z.string().max(200).optional(), playlist: z.string().optional(), youtube_status: z.enum(YOUTUBE_STATUSES).optional(), archived: z.enum(['true', 'false']).optional() }), req.query);
  res.json(await listVideos({ ...f, archived: f.archived === 'true' }));
}));
api.get('/videos/:id', h(async (req, res) => res.json(await getVideo(parse(uuid, req.params.id)))));
api.post('/videos', requirePermission('video.edit'), h(async (req, res) => res.status(201).json(await createVideo(parse(videoBody, req.body), req.user!))));
api.patch('/videos/:id', requirePermission('video.edit'), h(async (req, res) => res.json(await updateVideo(parse(uuid, req.params.id), parse(videoBody.partial(), req.body), req.user!))));
api.post('/videos/:id/merge-youtube', requirePermission('video.edit'), h(async (req, res) => {
  const { from } = parse(z.object({ from: uuid }), req.body);
  res.json(await mergeYoutubeRecord(parse(uuid, req.params.id), from, req.user!));
}));
api.post('/videos/:id/archive', requirePermission('video.edit'), h(async (req, res) => {
  const { archived } = parse(z.object({ archived: z.boolean() }), req.body);
  await setVideoArchived(parse(uuid, req.params.id), archived, req.user!);
  res.json({ ok: true });
}));
api.post('/videos/:id/derivatives', requirePermission('content.edit'), h(async (req, res) => {
  const { kind } = parse(z.object({ kind: z.enum(['reel', 'micro', 'carousel']) }), req.body);
  res.status(201).json(await createDerivative(parse(uuid, req.params.id), kind, req.user!));
}));
api.post('/videos/sync-drive', requirePermission('sheet.sync'), h(async (req, res) => res.json(await syncDrive(req.user!))));

// ---------- Campaigns ----------

const campaignBody = z.object({
  name: z.string().trim().min(1).max(200),
  description: optStr,
  status: z.enum(['planned', 'active', 'paused', 'completed']).default('active'),
  target_count: z.coerce.number().int().min(0).max(100_000).nullish(),
  starts_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish().or(z.literal('').transform(() => null)),
  ends_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish().or(z.literal('').transform(() => null)),
  lead_magnet_name: optStr,
  lead_magnet_url: z.string().url().nullish().or(z.literal('').transform(() => null)),
  cta_text: optStr,
});
api.get('/campaigns', h(async (_req, res) => {
  const { rows } = await query(`SELECT c.*,
      (SELECT count(*) FROM content_items i WHERE i.campaign_id = c.id AND i.archived_at IS NULL) AS items,
      (SELECT count(*) FROM content_items i WHERE i.campaign_id = c.id AND i.publish_status = 'published') AS items_published,
      (SELECT count(*) FROM content_items i WHERE i.campaign_id = c.id AND i.approval_status = 'pending') AS items_pending,
      (SELECT count(*) FROM videos v WHERE v.campaign_id = c.id AND v.archived_at IS NULL) AS videos,
      (SELECT count(*) FROM videos v WHERE v.campaign_id = c.id AND v.youtube_status = 'public') AS videos_public
    FROM campaigns c ORDER BY c.status = 'active' DESC, c.created_at`);
  res.json(rows);
}));
api.post('/campaigns', requirePermission('campaign.edit'), h(async (req, res) => {
  const b = parse(campaignBody, req.body);
  const slug = b.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) + '-' + crypto.randomBytes(2).toString('hex');
  const { rows } = await query(
    `INSERT INTO campaigns (slug, name, description, status, target_count, starts_on, ends_on, lead_magnet_name, lead_magnet_url, cta_text)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [slug, b.name, b.description, b.status, b.target_count, b.starts_on, b.ends_on, b.lead_magnet_name, b.lead_magnet_url, b.cta_text],
  );
  await audit({ actor: req.user!, action: 'campaign.create', entityType: 'campaign', entityId: rows[0].id, next: b, result: 'success' });
  res.status(201).json(rows[0]);
}));
api.patch('/campaigns/:id', requirePermission('campaign.edit'), h(async (req, res) => {
  const id = parse(uuid, req.params.id);
  const b = parse(campaignBody.partial(), req.body);
  const { rows } = await query('SELECT * FROM campaigns WHERE id = $1', [id]);
  if (!rows[0]) throw new HttpError(404, 'Campaign not found.');
  const keys = Object.keys(b);
  if (!keys.length) return res.json(rows[0]);
  const upd = await query(
    `UPDATE campaigns SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, ...keys.map((k) => (b as any)[k])],
  );
  await audit({ actor: req.user!, action: 'campaign.update', entityType: 'campaign', entityId: id, previous: Object.fromEntries(keys.map((k) => [k, rows[0][k]])), next: b, result: 'success' });
  res.json(upd.rows[0]);
}));

// ---------- Sync, connections ----------

api.post('/sync/sheet', requirePermission('sheet.sync'), h(async (req, res) => {
  try {
    res.json(await syncSheet(req.user!));
  } catch (e) {
    throw new HttpError(502, `Sheet import failed: ${(e as Error).message}`);
  }
}));
api.get('/connections', h(async (_req, res) => res.json(await listConnections())));
api.post('/connections/:key/test', requirePermission('connections.test'), h(async (req, res) => {
  const key = parse(z.enum(CONNECTION_KEYS), req.params.key) as ConnectionKey;
  res.json(await testConnection(key, req.user!));
}));
api.post('/connections/:key/automation', requirePermission('connections.automation'), h(async (req, res) => {
  const key = parse(z.enum(CONNECTION_KEYS), req.params.key) as ConnectionKey;
  const { enabled, confirm } = parse(z.object({ enabled: z.boolean(), confirm: z.string() }), req.body);
  if (enabled && confirm !== key) throw new HttpError(400, `Type "${key}" to confirm.`);
  await setAutomation(key, enabled, req.user!);
  res.json(await listConnections());
}));

// ---------- Google / YouTube ----------

api.get('/oauth/google/start', requirePermission('connections.automation'), h(async (_req, res) => {
  if (!oauthConfigured()) throw new HttpError(412, 'Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in Railway first.');
  const state = newState();
  res.cookie(OAUTH_STATE_COOKIE, state, { httpOnly: true, sameSite: 'lax', secure: config.NODE_ENV === 'production', maxAge: 10 * 60_000, path: '/api/oauth' });
  res.redirect(authUrl(state));
}));
api.delete('/oauth/google', requirePermission('connections.automation'), h(async (req, res) => {
  await disconnectGoogle(req.user!, typeof req.query.channel === 'string' ? req.query.channel : undefined);
  res.json({ ok: true });
}));
api.post('/youtube/channels/:id/main', requirePermission('connections.automation'), h(async (req, res) => {
  await makeMainChannel(parse(z.string().regex(/^UC[A-Za-z0-9_-]{22}$/), req.params.id), req.user!);
  res.json({ ok: true });
}));
// One-time link for the channel owner (see the public routes above requireAuth).
api.post('/oauth/google/invite', requirePermission('connections.automation'), h(async (req, res) => {
  res.status(201).json(await createConnectInvite(req.user!));
}));
api.delete('/oauth/google/invite', requirePermission('connections.automation'), h(async (req, res) => {
  await revokeConnectInvites(req.user!);
  res.json({ ok: true });
}));

// ---------- Canva ----------

const CANVA_STATE_COOKIE = 'cos_canva_oauth';
api.get('/oauth/canva/start', requirePermission('connections.automation'), h(async (_req, res) => {
  if (!canvaConfigured()) throw new HttpError(412, 'Set CANVA_CLIENT_ID and CANVA_CLIENT_SECRET in Railway first.');
  const { url, state, verifier } = canvaAuthStart();
  res.cookie(CANVA_STATE_COOKIE, `${state}.${verifier}`, { httpOnly: true, sameSite: 'lax', secure: config.NODE_ENV === 'production', maxAge: 10 * 60_000, path: '/api/oauth' });
  res.redirect(url);
}));
api.get('/oauth/canva/callback', requirePermission('connections.automation'), h(async (req, res) => {
  const back = (q: string) => res.redirect(`/connections?${q}`);
  const [state, verifier] = String(req.cookies?.[CANVA_STATE_COOKIE] ?? '').split('.');
  res.clearCookie(CANVA_STATE_COOKIE, { path: '/api/oauth' });
  if (req.query.error) return back(`canva_error=${encodeURIComponent(String(req.query.error_description ?? req.query.error))}`);
  if (!state || !verifier || state !== req.query.state) return back('canva_error=' + encodeURIComponent('Sign-in session expired or did not match. Try Connect Canva again.'));
  try {
    const r = await completeCanvaConsent(String(req.query.code ?? ''), verifier, req.user!);
    back(`canva=connected&account=${encodeURIComponent(r.name)}`);
  } catch (e) {
    await audit({ actor: req.user!, action: 'oauth.canva.connect', entityType: 'connection', entityId: 'canva', result: 'failure', detail: (e as Error).message });
    back(`canva_error=${encodeURIComponent((e as Error).message)}`);
  }
}));
api.delete('/oauth/canva', requirePermission('connections.automation'), h(async (req, res) => {
  await disconnectCanva(req.user!);
  res.json({ ok: true });
}));

// ---------- Canva MCP (brand checks and logo fixes) ----------

const CANVA_MCP_STATE_COOKIE = 'cos_canva_mcp_oauth';
api.get('/oauth/canva-mcp/start', requirePermission('connections.automation'), h(async (_req, res) => {
  const { url, state, verifier } = await canvaMcpAuthStart();
  res.cookie(CANVA_MCP_STATE_COOKIE, `${state}.${verifier}`, { httpOnly: true, sameSite: 'lax', secure: config.NODE_ENV === 'production', maxAge: 10 * 60_000, path: '/api/oauth' });
  res.redirect(url);
}));
// Same as /complete, for a loopback helper that forwards Canva's redirect here as a normal navigation.
api.get('/oauth/canva-mcp/finish', requirePermission('connections.automation'), h(async (req, res) => {
  const back = (q: string) => res.redirect(`/connections?${q}`);
  const [state, verifier] = String(req.cookies?.[CANVA_MCP_STATE_COOKIE] ?? '').split('.');
  if (req.query.error) return back(`canva_mcp_error=${encodeURIComponent(String(req.query.error_description ?? req.query.error))}`);
  if (!state || !verifier || state !== req.query.state) return back('canva_mcp_error=' + encodeURIComponent('Sign-in session expired or did not match. Try again.'));
  res.clearCookie(CANVA_MCP_STATE_COOKIE, { path: '/api/oauth' });
  try {
    const r = await completeCanvaMcpConsent(String(req.query.code ?? ''), verifier, req.user!);
    back(`canva_mcp=connected&tools=${r.tools}`);
  } catch (e) {
    await audit({ actor: req.user!, action: 'oauth.canva_mcp.connect', entityType: 'connection', entityId: 'canva', result: 'failure', detail: (e as Error).message });
    back(`canva_mcp_error=${encodeURIComponent((e as Error).message)}`);
  }
}));
api.post('/oauth/canva-mcp/complete', requirePermission('connections.automation'), h(async (req, res) => {
  const b = parse(z.object({ url: z.string().min(10).max(4000) }), req.body);
  const [state, verifier] = String(req.cookies?.[CANVA_MCP_STATE_COOKIE] ?? '').split('.');
  if (!state || !verifier) throw new HttpError(400, 'The sign-in session expired. Click "Sign in to Canva" again.');
  const got = parsePastedRedirect(b.url);
  if (got.state !== state) throw new HttpError(400, 'That address is from a different sign-in. Click "Sign in to Canva" again and paste the new address.');
  try {
    const r = await completeCanvaMcpConsent(got.code, verifier, req.user!);
    res.clearCookie(CANVA_MCP_STATE_COOKIE, { path: '/api/oauth' });
    res.json({ ok: true, tools: r.tools });
  } catch (e) {
    await audit({ actor: req.user!, action: 'oauth.canva_mcp.connect', entityType: 'connection', entityId: 'canva', result: 'failure', detail: (e as Error).message });
    throw e instanceof HttpError ? e : new HttpError(502, (e as Error).message);
  }
}));
api.delete('/oauth/canva-mcp', requirePermission('connections.automation'), h(async (req, res) => {
  await disconnectCanvaMcp(req.user!);
  res.json({ ok: true });
}));
api.get('/canva/mcp', h(async (_req, res) => {
  const conn = await canvaMcpConnection();
  res.json({ connected: !!conn, connected_by: conn?.account_name ?? null, connected_at: conn?.connected_at ?? null, rules: await getBrandRules() });
}));
api.post('/canva/mcp/test', requirePermission('connections.automation'), h(async (_req, res) => {
  res.json({ ok: true, detail: await canvaMcpProbe() });
}));
api.get('/canva/mcp/tools', requirePermission('connections.automation'), h(async (req, res) => {
  const names = String(req.query.names ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  res.json(await describeTools(names));
}));
api.post('/canva/mcp/inspect', requirePermission('connections.automation'), h(async (req, res) => {
  const b = parse(z.object({ design_id: z.string().regex(/^D[A-Za-z0-9_-]{10}$/) }), req.body);
  res.json(await inspectDesign(b.design_id));
}));
api.put('/canva/brand-rules', requirePermission('connections.automation'), h(async (req, res) => {
  const b = parse(z.object({
    approved_logo_asset_ids: z.array(z.string().max(60)).max(20).optional(),
    blocked_asset_ids: z.array(z.string().max(60)).max(100).optional(),
    logo_asset_for_fix: z.string().regex(/^M[A-Za-z0-9_-]{6,}$/).nullable().optional(),
  }), req.body);
  res.json(await setBrandRules(b, req.user!));
}));
api.post('/canva/brand-check-recent', requirePermission('content.edit'), h(async (req, res) => {
  res.json(await checkRecentAssets(req.user!));
}));
api.post('/assets/:id/brand-check', requirePermission('content.edit'), h(async (req, res) => {
  res.json(await checkAsset(parse(uuid, req.params.id), req.user!));
}));
api.post('/assets/:id/fix-logo', requirePermission('content.edit'), h(async (req, res) => {
  res.json(await fixAssetLogo(parse(uuid, req.params.id), req.user!));
}));

api.get('/canva/templates', requirePermission('content.edit'), h(async (req, res) => {
  res.json(await listTemplates(typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : undefined));
}));
api.get('/canva/templates/:kind/:id/fields', requirePermission('content.edit'), h(async (req, res) => {
  const kind = parse(templateKind, req.params.kind);
  const id = parse(z.string().regex(/^[A-Za-z0-9_-]{4,64}$/), req.params.id);
  const dataset = await templateDataset(id, kind);
  res.json({ fields: Object.entries(dataset).map(([name, d]) => ({ name, type: d.type, guess: d.type === 'text' ? guessSource(name) : 'none' })), sources: FIELD_SOURCES });
}));
const templateKind = z.enum(['brand', 'design']);
const fieldSource = z.enum(Object.keys(FIELD_SOURCES) as [FieldSource, ...FieldSource[]]);
const mappingSchema = z.record(z.string().max(100), fieldSource);
api.post('/content/:id/canva', requirePermission('content.edit'), h(async (req, res) => {
  const b = parse(
    z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('template'), template_id: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/), template_kind: templateKind.optional(), mapping: mappingSchema.optional() }),
      z.object({ mode: z.literal('design'), design: z.string().trim().min(8).max(500) }),
    ]),
    req.body,
  );
  res.status(201).json(await generateForContent(parse(uuid, req.params.id), b, req.user!));
}));

api.get('/canva/automation', h(async (_req, res) => {
  const rule = await getRule();
  res.json({ rule, candidates: rule.template_id ? await ruleCandidates(rule, 20) : [] });
}));
api.put('/canva/automation', requirePermission('connections.automation'), h(async (req, res) => {
  const b = parse(
    z.object({
      enabled: z.boolean().optional(),
      confirm: z.string().optional(),
      template_id: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/).nullable().optional(),
      template_kind: templateKind.optional(),
      template_title: z.string().max(255).nullable().optional(),
      mapping: mappingSchema.optional(),
      lookahead_days: z.number().int().min(1).max(60).optional(),
      max_per_run: z.number().int().min(1).max(20).optional(),
    }),
    req.body,
  );
  if (b.enabled && b.confirm !== 'canva') throw new HttpError(400, 'Type "canva" to confirm.');
  const { confirm: _c, ...patch } = b;
  res.json({ rule: await setRule(patch, req.user!) });
}));
api.post('/canva/automation/run', requirePermission('connections.automation'), h(async (_req, res) => {
  res.json(await runCanvaAutomation());
}));

// One click: a graphic for every upcoming post that needs one (stored unapproved), and one post at a time.
api.get('/canva/generate-all', h(async (_req, res) => {
  const posts = await bulkCandidates();
  res.json({ job: bulkStatus(), pending: posts.length, refs: posts.map((p) => p.ref) });
}));
api.post('/canva/generate-all', requirePermission('content.edit'), h(async (req, res) => {
  res.status(202).json({ job: await startBulkGenerate(req.user!) });
}));
// Live social stats for Home. Cached for a minute so many open dashboards cost one set of API calls.
let perfCache: { at: number; value: unknown } | null = null;
let perfPending: Promise<unknown> | null = null;
api.get('/performance', h(async (_req, res) => {
  if (!perfCache || Date.now() - perfCache.at > 60_000) {
    perfPending ??= (async () => {
      const none = { available: false, account: null, followers: null, posts: [], totals: { views: null, likes: 0, comments: 0, shares: null }, note: 'YouTube is not connected yet.' };
      const [meta, channels] = await Promise.all([metaPerformance(), youtubeChannels()]);
      const yts = await Promise.all(channels.map((c) => youtubePerformance(12, c.channel_id)
        .then((s) => ({ ...s, channel_id: c.channel_id, primary: c.is_primary }))
        .catch((e) => ({ ...none, account: c.title, note: (e as Error).message, channel_id: c.channel_id, primary: c.is_primary }))));
      perfCache = { at: Date.now(), value: { updated_at: new Date().toISOString(), facebook: meta.facebook, instagram: meta.instagram, youtube: yts[0] ?? none, youtube_channels: yts.length ? yts : [none] } };
    })().finally(() => { perfPending = null; });
    await perfPending;
  }
  res.json(perfCache!.value);
}));
api.get('/canva/overview', h(async (_req, res) => res.json(await graphicsOverview())));
api.post('/content/:id/canva/auto', requirePermission('content.edit'), h(async (req, res) => {
  res.status(201).json(await autoGenerate(parse(uuid, req.params.id), req.user!));
}));

async function requireYoutubeAutomation() {
  const { rows } = await query(`SELECT status, automation_enabled FROM connections WHERE key = 'youtube'`);
  if (!(await googleConnection())) throw new HttpError(412, 'YouTube is not connected.');
  if (!rows[0]?.automation_enabled) throw new HttpError(412, 'An administrator must enable YouTube automation on the Connections page before the dashboard can change the channel.');
}

api.get('/youtube/channel', h(async (_req, res) => {
  if (!(await googleConnection())) return res.json({ connected: false });
  res.json({ connected: true, ...(await channelSummary()) });
}));
api.post('/youtube/sync', requirePermission('sheet.sync'), h(async (req, res) => res.json(await syncChannel(req.user!))));
api.post('/youtube/playlists', requirePermission('video.edit'), h(async (req, res) => {
  await requireYoutubeAutomation();
  res.json(await ensurePlaylists(req.user!));
}));
api.post('/videos/:id/youtube/push', requirePermission('video.edit'), h(async (req, res) => {
  const b = parse(z.object({ visibility: z.enum(['private', 'unlisted', 'public', 'scheduled']) }), req.body);
  await requireYoutubeAutomation();
  res.json(await pushVideo(parse(uuid, req.params.id), b.visibility, req.user!));
}));
api.post('/videos/:id/youtube/upload', requirePermission('video.edit'), h(async (req, res) => {
  const b = parse(z.object({ visibility: z.enum(['private', 'unlisted', 'scheduled']) }), req.body);
  await requireYoutubeAutomation();
  res.status(202).json(await startUpload(parse(uuid, req.params.id), b.visibility, req.user!));
}));

// ---------- Meta (Facebook Pages + Instagram) ----------

api.post('/meta/pages/sync', requirePermission('connections.automation'), h(async (req, res) => {
  if (!metaTokenConfigured()) throw new HttpError(412, 'Set META_SYSTEM_USER_TOKEN in Railway first.');
  res.json(await syncPages(req.user!));
}));
api.post('/meta/private-test', requirePermission('connections.automation'), h(async (req, res) => {
  const b = parse(z.object({ asset_id: uuid, caption: z.string().max(500).default('Content OS private connection test') }), req.body);
  try {
    res.json(await privateTest(b.asset_id, b.caption, req.user!));
  } catch (e) {
    await audit({ actor: req.user!, action: 'meta.private_test', entityType: 'connection', entityId: 'facebook', result: 'failure', detail: (e as Error).message });
    throw e;
  }
}));
api.patch('/meta/pages/:id', requirePermission('connections.automation'), h(async (req, res) => {
  const b = parse(z.object({ enabled: z.boolean().optional(), is_default: z.literal(true).optional() }), req.body);
  res.json(await updatePage(parse(z.string().regex(/^\d{5,30}$/), req.params.id), b, req.user!));
}));

// ---------- Activity ----------

api.get('/activity', requirePermission('audit.view'), h(async (req, res) => {
  const f = parse(z.object({
    q: z.string().max(200).optional(),
    result: z.enum(['success', 'failure', 'denied']).optional(),
    page: z.coerce.number().int().min(1).default(1),
  }), req.query);
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.q) {
    params.push(`%${f.q}%`);
    where.push(`(action ILIKE $${params.length} OR actor_email ILIKE $${params.length} OR content_ref ILIKE $${params.length} OR detail ILIKE $${params.length} OR execution_id ILIKE $${params.length})`);
  }
  if (f.result) {
    params.push(f.result);
    where.push(`result = $${params.length}`);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = await query(`SELECT count(*) AS n FROM audit_log ${w}`, params);
  params.push((f.page - 1) * 50);
  const { rows } = await query(`SELECT * FROM audit_log ${w} ORDER BY created_at DESC LIMIT 50 OFFSET $${params.length}`, params);
  res.json({ items: rows, total: total.rows[0].n, page: f.page, pageSize: 50 });
}));
api.get('/runs', h(async (req, res) => {
  const f = parse(z.object({ status: z.enum(['running', 'succeeded', 'failed']).optional() }), req.query);
  const { rows } = await query(
    `SELECT w.id, w.kind, w.status, w.summary, w.error, w.execution_id, w.started_at, w.finished_at, w.content_id, w.queue_item_id,
       c.ref, u.name AS triggered_by_name, q.state AS queue_state
     FROM workflow_runs w LEFT JOIN content_items c ON c.id = w.content_id LEFT JOIN users u ON u.id = w.triggered_by
     LEFT JOIN queue_items q ON q.id = w.queue_item_id
     ${f.status ? 'WHERE w.status = $1' : ''} ORDER BY w.started_at DESC LIMIT 200`,
    f.status ? [f.status] : [],
  );
  res.json(rows);
}));
api.get('/runs/:id', h(async (req, res) => {
  const { rows } = await query('SELECT * FROM workflow_runs WHERE id = $1', [parse(uuid, req.params.id)]);
  if (!rows[0]) throw new HttpError(404, 'Run not found.');
  res.json(rows[0]);
}));

// ---------- Users & settings ----------

api.get('/users', requirePermission('users.manage'), h(async (_req, res) => {
  const { rows } = await query('SELECT id, email, name, role, active, last_login_at, created_at FROM users ORDER BY created_at');
  res.json(rows);
}));
api.post('/users', requirePermission('users.manage'), h(async (req, res) => {
  const b = parse(z.object({ email: z.string().email(), name: z.string().trim().min(1).max(120), role: z.enum(ROLES), password: z.string().trim().min(10, 'Use at least 10 characters') }), req.body);
  if ((await usersWithPassword(b.password)).length) throw new HttpError(409, 'Another user already has this password. Sign-in is password-only, so each user needs a different one.');
  const { rows } = await query(
    'INSERT INTO users (email, name, role, password_hash) VALUES (lower($1),$2,$3,$4) RETURNING id, email, name, role, active',
    [b.email, b.name, b.role, await hashPassword(b.password)],
  );
  await audit({ actor: req.user!, action: 'user.create', entityType: 'user', entityId: rows[0].id, next: { email: b.email, role: b.role }, result: 'success' });
  res.status(201).json(rows[0]);
}));
api.patch('/users/:id', requirePermission('users.manage'), h(async (req, res) => {
  const id = parse(uuid, req.params.id);
  const b = parse(z.object({ role: z.enum(ROLES).optional(), active: z.boolean().optional(), name: z.string().trim().min(1).max(120).optional(), password: z.string().min(10).optional() }), req.body);
  if (id === req.user!.id && (b.role && b.role !== 'admin' || b.active === false)) {
    throw new HttpError(400, 'You cannot remove your own administrator access.');
  }
  const { rows } = await query('SELECT id, email, role, active, name FROM users WHERE id = $1', [id]);
  if (!rows[0]) throw new HttpError(404, 'User not found.');
  const sets: string[] = [];
  const vals: unknown[] = [id];
  for (const k of ['role', 'active', 'name'] as const) {
    if (b[k] !== undefined) {
      vals.push(b[k]);
      sets.push(`${k} = $${vals.length}`);
    }
  }
  if (b.password) {
    if ((await usersWithPassword(b.password, id)).length) throw new HttpError(409, 'Another user already has this password. Choose a different one.');
    vals.push(await hashPassword(b.password));
    sets.push(`password_hash = $${vals.length}`);
  }
  if (sets.length) await query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, vals);
  if (b.active === false || b.password) await query('DELETE FROM sessions WHERE user_id = $1', [id]);
  const { password: _pw, ...logged } = b;
  await audit({ actor: req.user!, action: 'user.update', entityType: 'user', entityId: id, previous: { role: rows[0].role, active: rows[0].active, name: rows[0].name }, next: { ...logged, password_reset: !!b.password }, result: 'success' });
  res.json({ ok: true });
}));

api.get('/settings', h(async (_req, res) => {
  const { rows } = await query('SELECT key, value, updated_at FROM settings ORDER BY key');
  res.json({
    values: Object.fromEntries(rows.map((r) => [r.key, r.value])),
    environment: {
      timezone: config.APP_TIMEZONE,
      db_schema: config.DB_SCHEMA,
      sheet_configured: !!config.GOOGLE_SHEET_ID,
      n8n_configured: !!config.N8N_PUBLISH_WEBHOOK_URL,
      dispatcher_enabled: config.DISPATCHER_ENABLED,
      railway_environment: config.RAILWAY_ENVIRONMENT_NAME ?? null,
      commit: config.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    },
  });
}));
const SETTINGS = z.object({
  default_cta: z.string().max(500).optional(),
  disclaimer: z.string().max(1000).optional(),
  brand_voice: z.string().max(6000).optional(),
  default_post_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
});
api.put('/settings', requirePermission('settings.manage'), h(async (req, res) => {
  const b = parse(SETTINGS, req.body);
  for (const [k, v] of Object.entries(b)) {
    const prev = await query('SELECT value FROM settings WHERE key = $1', [k]);
    await query(
      `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [k, JSON.stringify(v), req.user!.id],
    );
    await audit({ actor: req.user!, action: 'settings.update', entityType: 'setting', entityId: k, previous: prev.rows[0]?.value ?? null, next: v, result: 'success' });
  }
  res.json({ ok: true });
}));
