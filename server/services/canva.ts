import crypto from 'node:crypto';
import { query, tx } from '../db/pool.js';
import { config } from '../config.js';
import type { SessionUser } from '../../shared/domain.js';
import { open, seal } from './secretbox.js';
import { audit } from './audit.js';
import { HttpError } from '../http.js';
import { publicBaseUrl } from './googleOAuth.js';
import { storeGeneratedImage } from './content.js';
import { recordCanvaAsset } from './canvaMcp.js';

// Canva Connect. A team member approves once; tokens are stored encrypted. Canva refresh tokens
// are single-use, so a refresh happens under a row lock and the new refresh token is saved at once.
//
// Two ways to get an image onto a post, both stored as an UNAPPROVED asset (an approver still has
// to approve it, and adding it returns an approved post to draft):
//   - template: autofill a brand template with the post's text, then export page 1 as PNG
//   - design:   export an existing Canva design (e.g. one a designer made) as PNG

const API = 'https://api.canva.com/rest/v1';
export const CANVA_SCOPES = [
  'profile:read',
  'design:meta:read',
  'design:content:read',
  'design:content:write',
  'brandtemplate:meta:read',
  'brandtemplate:content:read',
];

export const canvaConfigured = () => !!(process.env.CANVA_CLIENT_ID && process.env.CANVA_CLIENT_SECRET);
export const canvaRedirectUri = () => `${publicBaseUrl()}/api/oauth/canva/callback`;

export function canvaAuthStart() {
  const state = crypto.randomBytes(24).toString('base64url');
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const p = new URLSearchParams({
    code_challenge: challenge,
    // Lowercase, as in the Developer Portal's own authorization URL generator.
    code_challenge_method: 's256',
    scope: CANVA_SCOPES.join(' '),
    response_type: 'code',
    client_id: process.env.CANVA_CLIENT_ID!,
    state,
    redirect_uri: canvaRedirectUri(),
  });
  return { url: `https://www.canva.com/api/oauth/authorize?${p}`, state, verifier };
}

async function tokenRequest(body: Record<string, string>) {
  const basic = Buffer.from(`${process.env.CANVA_CLIENT_ID}:${process.env.CANVA_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(20_000),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error_description ?? json.message ?? json.error ?? `Canva token endpoint HTTP ${res.status}`);
  return json as { access_token: string; refresh_token: string; expires_in: number; scope: string };
}

async function rawApi(token: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json.message ?? json.error?.message ?? `HTTP ${res.status}`;
    const hint =
      res.status === 403 && path.startsWith('/brand-templates') ? ' Brand templates and autofill need a Canva Pro, Teams or Enterprise plan on the connected account.'
      : res.status === 403 && path.startsWith('/autofills') ? ' Autofill needs a Canva Pro, Teams or Enterprise plan on the connected account.'
      : res.status === 404 && path.startsWith('/designs') ? ' The connected Canva account cannot see that design; share it with that account.'
      : res.status === 403 && /scope/i.test(msg) ? ' Enable this scope on the integration in the Canva Developer Portal, then reconnect Canva.'
      : '';
    throw new HttpError(res.status === 401 ? 412 : 502, `Canva: ${msg}.${hint}`);
  }
  return json;
}

/** Exchange the consent code, identify the Canva user, and store the tokens. */
export async function completeCanvaConsent(code: string, verifier: string, user: SessionUser) {
  const t = await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: canvaRedirectUri() });
  const me = await rawApi(t.access_token, '/users/me');
  const profile = await rawApi(t.access_token, '/users/me/profile').catch(() => ({}));
  const name = profile.profile?.display_name ?? 'Canva user';
  await query(
    `INSERT INTO oauth_tokens (provider, account_id, account_name, scopes, access_token_enc, refresh_token_enc, expires_at, connected_by)
     VALUES ('canva', $1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (provider) DO UPDATE SET account_id = EXCLUDED.account_id, account_name = EXCLUDED.account_name,
       scopes = EXCLUDED.scopes, access_token_enc = EXCLUDED.access_token_enc, refresh_token_enc = EXCLUDED.refresh_token_enc,
       expires_at = EXCLUDED.expires_at, connected_by = EXCLUDED.connected_by, connected_at = now(), updated_at = now()`,
    [me.team_user?.user_id ?? null, name, t.scope ?? CANVA_SCOPES.join(' '), seal(t.access_token), seal(t.refresh_token), new Date(Date.now() + t.expires_in * 1000), user.id],
  );
  await query(`UPDATE connections SET status = 'connected', last_success_at = now(), last_checked_at = now(), last_error = NULL WHERE key = 'canva'`);
  await audit({ actor: user, action: 'oauth.canva.connect', entityType: 'connection', entityId: 'canva', next: { account: name, scopes: t.scope }, result: 'success' });
  return { name };
}

export async function canvaConnection() {
  const { rows } = await query(`SELECT account_name, scopes, connected_at FROM oauth_tokens WHERE provider = 'canva'`);
  return (rows[0] as { account_name: string; scopes: string; connected_at: string } | undefined) ?? null;
}

/** A valid access token, refreshed under a row lock (Canva refresh tokens work once). */
export async function canvaAccessToken(): Promise<string> {
  try {
    return await tx(async (client) => {
      const { rows } = await client.query(`SELECT * FROM oauth_tokens WHERE provider = 'canva' FOR UPDATE`);
      const row = rows[0];
      if (!row) throw new HttpError(412, 'Canva is not connected. An administrator must click "Connect Canva" on the Connections page.');
      if (new Date(row.expires_at).getTime() > Date.now() + 60_000) return open(row.access_token_enc);
      const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: open(row.refresh_token_enc) });
      await client.query(
        `UPDATE oauth_tokens SET access_token_enc = $1, refresh_token_enc = $2, expires_at = $3, updated_at = now() WHERE provider = 'canva'`,
        [seal(t.access_token), seal(t.refresh_token), new Date(Date.now() + t.expires_in * 1000)],
      );
      return t.access_token;
    });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    const msg = `Canva authorization failed: ${(e as Error).message}. Reconnect Canva on the Connections page.`;
    await query(`UPDATE connections SET status = 'disconnected', last_error = $1, last_error_at = now() WHERE key = 'canva'`, [msg]);
    throw new HttpError(412, msg);
  }
}

async function canva(path: string, init: RequestInit = {}) {
  return rawApi(await canvaAccessToken(), path, init);
}

export async function disconnectCanva(user: SessionUser) {
  const { rows } = await query(`SELECT refresh_token_enc FROM oauth_tokens WHERE provider = 'canva'`);
  if (rows[0]) {
    // Best effort: revoke at Canva so the grant disappears from the account too.
    try {
      const basic = Buffer.from(`${process.env.CANVA_CLIENT_ID}:${process.env.CANVA_CLIENT_SECRET}`).toString('base64');
      await fetch(`${API}/oauth/revoke`, {
        method: 'POST',
        headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: open(rows[0].refresh_token_enc) }),
      });
    } catch {}
  }
  await query(`DELETE FROM oauth_tokens WHERE provider = 'canva'`);
  await query(`UPDATE connections SET status = 'not_configured' WHERE key = 'canva'`);
  await setRule({ enabled: false }, user, 'Canva disconnected');
  await audit({ actor: user, action: 'oauth.canva.disconnect', entityType: 'connection', entityId: 'canva', result: 'success' });
}

export async function canvaProbe() {
  const p = await canva('/users/me/profile');
  const t = await listTemplates().catch(() => null);
  const templates = t ? `${t.length} autofill template${t.length === 1 ? '' : 's'}` : 'templates unavailable';
  return `${p.profile?.display_name ?? 'Canva user'} · ${templates}`;
}

// ---------- Templates and designs ----------

/**
 * Something Canva can autofill: a published brand template, or an ordinary design whose text
 * boxes have data fields (Canva's create_from_design). Design templates need no brand-template
 * publishing rights, so any team member can make one.
 */
export type TemplateKind = 'brand' | 'design';
export interface Template { id: string; kind: TemplateKind; title: string; view_url: string | null; thumbnail: string | null }

/** Designs are offered as templates when their title contains this word and they have data fields. */
export const DESIGN_TEMPLATE_WORD = 'Template';

export async function listTemplates(search?: string): Promise<Template[]> {
  const p = new URLSearchParams({ limit: '100', dataset: 'non_empty', sort_by: 'modified_descending' });
  if (search) p.set('query', search);
  // Brand templates need a paid team plan; a 403 just means there are none to offer.
  const brand = await canva(`/brand-templates?${p}`).catch((e) => {
    if (e instanceof HttpError && e.status === 412) throw e;
    return { items: [] };
  });
  const out: Template[] = (brand.items ?? []).map((t: any) => ({ id: t.id, kind: 'brand' as const, title: t.title, view_url: t.view_url ?? null, thumbnail: t.thumbnail?.url ?? null }));
  const d = await canva(`/designs?${new URLSearchParams({ query: search || DESIGN_TEMPLATE_WORD, ownership: 'any', sort_by: 'relevance', limit: '20' })}`);
  const designs = (d.items ?? []).filter((x: any) => new RegExp(DESIGN_TEMPLATE_WORD, 'i').test(x.title ?? '')).slice(0, 10);
  const checked = await Promise.all(designs.map(async (x: any) => (Object.keys(await designDataset(x.id).catch(() => ({}))).length ? x : null)));
  for (const x of checked.filter(Boolean)) {
    out.push({ id: x.id, kind: 'design', title: x.title, view_url: x.urls?.view_url ?? null, thumbnail: x.thumbnail?.url ?? null });
  }
  return out;
}

const datasetCache = new Map<string, { at: number; value: Record<string, { type: string }> }>();
async function designDataset(designId: string) {
  const hit = datasetCache.get(designId);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const r = await canva(`/designs/${encodeURIComponent(designId)}/dataset`);
  const value = (r.dataset ?? {}) as Record<string, { type: string }>;
  datasetCache.set(designId, { at: Date.now(), value });
  return value;
}

export async function templateDataset(templateId: string, kind: TemplateKind = 'brand'): Promise<Record<string, { type: string }>> {
  if (kind === 'design') return designDataset(templateId);
  const r = await canva(`/brand-templates/${encodeURIComponent(templateId)}/dataset`);
  return r.dataset ?? {};
}

/** Accepts a Canva design link or a bare design id. */
export function parseDesignId(input: string): string | null {
  const m = input.match(/canva\.com\/design\/([A-Za-z0-9_-]{8,})/) ?? input.trim().match(/^(D[A-Za-z0-9_-]{8,})$/);
  return m?.[1] ?? null;
}

async function pollJob(path: string, timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  for (let wait = 1500; ; wait = Math.min(wait * 1.5, 5000)) {
    const r = await canva(path);
    if (r.job?.status === 'success') return r.job;
    if (r.job?.status === 'failed') throw new HttpError(502, `Canva: ${r.job.error?.message ?? 'job failed'}.`);
    if (Date.now() > until) throw new HttpError(504, 'Canva is still working on it; try again in a minute.');
    await new Promise((res) => setTimeout(res, wait));
  }
}

/** Export page 1 and scale it to a social-sized JPEG (large Canva pages are 2000px+ PNGs). */
export const exportDesignImage = (designId: string) => exportImage(designId);
async function exportImage(designId: string): Promise<Buffer> {
  const start = await canva('/exports', { method: 'POST', body: JSON.stringify({ design_id: designId, format: { type: 'png', pages: [1] } }) });
  const job = await pollJob(`/exports/${start.job.id}`);
  const url = job.urls?.[0];
  if (!url) throw new HttpError(502, 'Canva finished the export but returned no file.');
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new HttpError(502, `Could not download the Canva export (HTTP ${res.status}).`);
  const png = Buffer.from(await res.arrayBuffer());
  const sharp = (await import('sharp')).default;
  const meta = await sharp(png).metadata();
  if ((meta.width ?? 0) <= 1440) return png;
  return sharp(png).resize({ width: 1440, withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

// ---------- Field mapping ----------

export const FIELD_SOURCES = {
  title_main: 'Title, after the dash',
  title_prefix: 'Title, before the dash (or campaign)',
  title: 'Title (full)',
  headline: 'Caption, first line',
  caption: 'Caption (full)',
  cta: 'Call to action',
  hashtags: 'Hashtags',
  date: 'Scheduled date and time',
  campaign: 'Campaign name',
  category: 'Category',
  none: 'Leave the template text',
} as const;
export type FieldSource = keyof typeof FIELD_SOURCES;

/** A sensible default source for a template field, from its name. */
export function guessSource(field: string): FieldSource {
  const f = field.toLowerCase();
  if (/hashtag/.test(f)) return 'hashtags';
  if (/cta|button|action/.test(f)) return 'cta';
  if (/date|when|day|time/.test(f)) return 'date';
  if (/campaign|event|eyebrow|kicker|series/.test(f)) return 'title_prefix';
  if (/category|tag|label/.test(f)) return 'category';
  if (/title|headline|heading|name/.test(f)) return 'title_main';
  if (/caption|body|text|copy|desc|sub/.test(f)) return 'headline';
  return 'none';
}

interface ItemText { title: string; caption: string | null; cta: string | null; hashtags: string | null; scheduled_at: string | null; campaign_name: string | null; category: string }

// "Black Sheep Convention – Mortgage Wraps Done Right" → prefix / main.
const splitTitle = (t: string) => {
  const m = t.match(/^(.{3,60}?)\s+[–—-]\s+(.+)$/);
  return m ? { prefix: m[1].trim(), main: m[2].trim() } : { prefix: null, main: t.trim() };
};

// The caption's first sentence, cut at a word boundary so it fits a text box.
function firstLine(caption: string | null, max = 110) {
  const s = (caption ?? '').split(/\n|(?<=[.!?])\s/)[0]?.trim() ?? '';
  if (s.length <= max) return s;
  return s.slice(0, s.lastIndexOf(' ', max - 1) > 40 ? s.lastIndexOf(' ', max - 1) : max - 1).replace(/[,;:\s]+$/, '') + '…';
}

function valueFor(src: FieldSource, c: ItemText): string {
  switch (src) {
    case 'title_main': return splitTitle(c.title).main;
    case 'title_prefix': return splitTitle(c.title).prefix ?? c.campaign_name ?? c.category;
    case 'title': return c.title;
    case 'headline': return firstLine(c.caption);
    case 'caption': return (c.caption ?? '').trim();
    case 'cta': return c.cta ?? '';
    case 'hashtags': return c.hashtags ?? '';
    case 'campaign': return c.campaign_name ?? '';
    case 'category': return c.category;
    case 'date':
      // An unscheduled post must not inherit the template's sample date.
      if (!c.scheduled_at) return 'Date to be announced';
      return new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: config.APP_TIMEZONE })
        .format(new Date(c.scheduled_at))
        .replace(/ at /, ' • ');
    case 'none': return '';
  }
}

async function itemText(contentId: string): Promise<ItemText & { ref: string }> {
  const { rows } = await query(
    `SELECT c.ref, c.title, c.caption, c.cta, c.hashtags, c.scheduled_at, c.category, k.name AS campaign_name
       FROM content_items c LEFT JOIN campaigns k ON k.id = c.campaign_id WHERE c.id = $1`,
    [contentId],
  );
  if (!rows[0]) throw new HttpError(404, 'Content not found.');
  return rows[0];
}

// ---------- Generation ----------

export type GenerateRequest =
  | { mode: 'template'; template_id: string; template_kind?: TemplateKind; mapping?: Record<string, FieldSource> }
  | { mode: 'design'; design: string };

/** Make an image in Canva for a post and store it as an unapproved asset. */
export async function generateForContent(contentId: string, req: GenerateRequest, user: SessionUser, trigger: 'manual' | 'automation' | 'bulk' = 'manual') {
  const item = await itemText(contentId);
  const { rows: run } = await query(
    `INSERT INTO workflow_runs (kind, content_id, summary, triggered_by, request) VALUES ('canva_generate', $1, $2, $3, $4) RETURNING id`,
    [contentId, `Canva ${req.mode === 'template' ? 'autofill' : 'export'} for ${item.ref}${trigger !== 'manual' ? ` (${trigger})` : ''}`, user.id, JSON.stringify({ ...req, trigger })],
  );
  try {
    let designId: string;
    let editUrl: string;
    let label: string;
    let filled: string[] = [];
    if (req.mode === 'template') {
      const kind = req.template_kind ?? 'brand';
      const dataset = await templateDataset(req.template_id, kind);
      const data: Record<string, { type: 'text'; text: string }> = {};
      for (const [field, def] of Object.entries(dataset)) {
        if (def.type !== 'text') continue;
        const text = valueFor(req.mapping?.[field] ?? guessSource(field), item);
        if (text) data[field] = { type: 'text', text };
      }
      filled = Object.keys(data);
      if (!filled.length) throw new HttpError(400, 'None of the template’s text fields could be filled from this post. Check the field mapping.');
      const title = `${item.ref} · ${item.title}`.slice(0, 255);
      const start = await canva('/autofills', {
        method: 'POST',
        body: JSON.stringify(
          kind === 'design'
            ? { type: 'create_from_design', design_id: req.template_id, title, data }
            : { type: 'create_from_brand_template', brand_template_id: req.template_id, title, data },
        ),
      });
      const job = await pollJob(`/autofills/${start.job.id}`);
      const design = job.result?.design;
      if (!design?.id) throw new HttpError(502, 'Canva autofill finished without a design.');
      designId = design.id;
      editUrl = design.urls?.edit_url ?? design.url ?? `https://www.canva.com/design/${design.id}/edit`;
      label = `Canva: ${design.title ?? item.title}`;
    } else {
      const id = parseDesignId(req.design);
      if (!id) throw new HttpError(400, 'Paste a Canva design link (canva.com/design/…) or a design id.');
      const d = await canva(`/designs/${id}`);
      designId = id;
      editUrl = `https://www.canva.com/design/${id}/edit`;
      label = `Canva: ${d.design?.title ?? id}`;
    }
    const img = await exportImage(designId);
    const asset = await storeGeneratedImage(contentId, img, { url: editUrl, label: label.slice(0, 200) }, user);
    // Brand check through Canva MCP (when connected): a fake logo blocks approval of this image.
    const brand_check = await recordCanvaAsset(asset.id, designId);
    await query(`UPDATE workflow_runs SET status = 'succeeded', finished_at = now(), response = $2 WHERE id = $1`, [
      run[0].id, JSON.stringify({ design_id: designId, edit_url: editUrl, asset_id: asset.id, bytes: img.length, filled, brand_check: brand_check?.status ?? 'not_checked' }),
    ]);
    await query(`UPDATE connections SET status = 'connected', last_success_at = now(), last_checked_at = now() WHERE key = 'canva'`);
    return { asset, design_id: designId, edit_url: editUrl, filled, brand_check };
  } catch (e) {
    const msg = (e as Error).message;
    await query(`UPDATE workflow_runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`, [run[0].id, msg]);
    await audit({ actor: user, action: 'canva.generate', entityType: 'content', entityId: contentId, contentRef: item.ref, result: 'failure', detail: msg });
    throw e;
  }
}

// ---------- Automation rule ----------

export interface CanvaRule {
  enabled: boolean;
  template_id: string | null;
  template_kind: TemplateKind;
  template_title: string | null;
  mapping: Record<string, FieldSource>;
  /** Only posts scheduled within this many days are generated. */
  lookahead_days: number;
  max_per_run: number;
  enabled_by: string | null;
  enabled_at: string | null;
}

const DEFAULT_RULE: CanvaRule = { enabled: false, template_id: null, template_kind: 'brand', template_title: null, mapping: {}, lookahead_days: 14, max_per_run: 5, enabled_by: null, enabled_at: null };

export async function getRule(): Promise<CanvaRule> {
  const { rows } = await query(`SELECT value FROM settings WHERE key = 'canva_automation'`);
  return { ...DEFAULT_RULE, ...(rows[0]?.value ?? {}) };
}

export async function setRule(patch: Partial<Omit<CanvaRule, 'enabled_by' | 'enabled_at'>>, user: SessionUser, reason?: string) {
  const prev = await getRule();
  const next: CanvaRule = { ...prev, ...patch };
  if (patch.template_id !== undefined && patch.template_id !== prev.template_id && patch.mapping === undefined) next.mapping = {};
  if (next.enabled && !prev.enabled) {
    if (!(await canvaConnection())) throw new HttpError(412, 'Connect Canva first.');
    if (!next.template_id) throw new HttpError(412, 'Choose a template first.');
    next.enabled_by = user.id;
    next.enabled_at = new Date().toISOString();
  }
  if (!next.enabled) next.enabled_by = next.enabled_at = null;
  await query(
    `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ('canva_automation', $1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [JSON.stringify(next), user.id],
  );
  await audit({ actor: user, action: 'canva.rule.update', entityType: 'setting', entityId: 'canva_automation', previous: prev, next, result: 'success', detail: reason ?? null });
  return next;
}

type Picked = { id: string; kind: TemplateKind; title: string; mapping: Record<string, FieldSource> };

let templatesCache: { at: number; list: Template[] } | null = null;
async function cachedTemplates() {
  if (!templatesCache || Date.now() - templatesCache.at > 5 * 60_000) templatesCache = { at: Date.now(), list: await listTemplates() };
  return templatesCache.list;
}

/** "Content OS – Black Sheep Template" → "Black Sheep": the words a post must mention to use it. */
export function templateKeyword(title: string) {
  return title.replace(/content\s*os/gi, '').replace(/templates?|posts?/gi, '').replace(/[–—\-|:·]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The fallback template: the rule's choice, else one named generic/default/Ceshker, else the newest. */
export async function defaultTemplate(): Promise<Picked> {
  const rule = await getRule();
  if (rule.template_id) return { id: rule.template_id, kind: rule.template_kind, title: rule.template_title ?? 'template', mapping: rule.mapping };
  const list = await cachedTemplates();
  const t = list.find((x) => /generic|default|ceshker post/i.test(x.title)) ?? list[0];
  if (!t) throw new HttpError(412, `No Canva template yet. Add data fields to a design whose title contains “${DESIGN_TEMPLATE_WORD}”, or publish a brand template.`);
  return { id: t.id, kind: t.kind, title: t.title, mapping: {} };
}

/**
 * The template for one post: a template whose keyword the post's title or campaign mentions
 * (longest keyword wins, so "Black Sheep" beats "Ceshker"), otherwise the default template.
 */
export async function pickTemplate(contentId: string): Promise<Picked> {
  const item = await itemText(contentId);
  const haystack = `${item.title} ${item.campaign_name ?? ''}`.toLowerCase();
  const fallback = await defaultTemplate();
  const match = (await cachedTemplates())
    .map((t) => ({ t, kw: templateKeyword(t.title).toLowerCase() }))
    .filter((x) => x.kw.length >= 3 && haystack.includes(x.kw))
    .sort((a, b) => b.kw.length - a.kw.length)[0];
  if (!match || match.t.id === fallback.id) return fallback;
  return { id: match.t.id, kind: match.t.kind, title: match.t.title, mapping: {} };
}

const templateRequest = (t: Picked): GenerateRequest => ({ mode: 'template', template_id: t.id, template_kind: t.kind, mapping: t.mapping });

/** One click for one post: the right template for it, filled, exported and attached (not approved). */
export async function autoGenerate(contentId: string, user: SessionUser) {
  const t = await pickTemplate(contentId);
  return { template: t.title, ...(await generateForContent(contentId, templateRequest(t), user)) };
}

// Posts that should carry a graphic but have no image or video yet. Approved posts are left alone:
// adding media would send them back to draft.
const NEEDS_GRAPHIC = `c.archived_at IS NULL
        AND c.publish_status IN ('unscheduled','failed')
        AND c.approval_status IN ('draft','pending','revision_requested')
        AND c.content_type IN ('post','story','event','carousel')
        AND EXISTS (SELECT 1 FROM content_targets t WHERE t.content_id = c.id AND t.platform IN ('facebook','instagram') AND t.placement IN ('feed','story'))
        AND NOT EXISTS (SELECT 1 FROM assets a WHERE a.content_id = c.id AND a.kind IN ('image','video'))`;

/**
 * Posts the rule would generate for: those needing a graphic, scheduled in the look-ahead window,
 * with no Canva attempt in the last 24 hours (so a failing post is not retried every run).
 */
export async function ruleCandidates(rule: CanvaRule, limit = rule.max_per_run) {
  const { rows } = await query(
    `SELECT c.id, c.ref, c.title, c.scheduled_at FROM content_items c
      WHERE ${NEEDS_GRAPHIC}
        AND c.scheduled_at BETWEEN now() AND now() + make_interval(days => $1)
        AND NOT EXISTS (SELECT 1 FROM workflow_runs w WHERE w.kind = 'canva_generate' AND w.content_id = c.id AND w.started_at > now() - interval '24 hours')
      ORDER BY c.scheduled_at LIMIT $2`,
    [rule.lookahead_days, limit],
  );
  return rows as { id: string; ref: string; title: string; scheduled_at: string }[];
}

/** Everything the "Auto-generate" button covers: every upcoming or unscheduled post needing a graphic. */
export async function bulkCandidates(limit = 50) {
  const { rows } = await query(
    `SELECT c.id, c.ref, c.title, c.scheduled_at FROM content_items c
      WHERE ${NEEDS_GRAPHIC} AND (c.scheduled_at IS NULL OR c.scheduled_at >= now())
      ORDER BY c.scheduled_at NULLS LAST, c.ref LIMIT $1`,
    [limit],
  );
  return rows as { id: string; ref: string; title: string; scheduled_at: string | null }[];
}

/** One pass of the rule. Runs as the administrator who switched it on, so the audit trail names them. */
export async function runCanvaAutomation(opts: { force?: boolean } = {}) {
  const rule = await getRule();
  if (!rule.enabled && !opts.force) return { ran: false, reason: 'Rule is off.', results: [] };
  if (!rule.template_id) return { ran: false, reason: 'No template chosen.', results: [] };
  if (!(await canvaConnection())) return { ran: false, reason: 'Canva is not connected.', results: [] };
  const { rows } = await query(`SELECT id, email, name, role FROM users WHERE id = $1 AND active AND role = 'admin'`, [rule.enabled_by]);
  const actor = rows[0] as SessionUser | undefined;
  if (!actor) return { ran: false, reason: 'The administrator who enabled the rule is no longer an active admin; switch it on again.', results: [] };
  const results: { ref: string; ok: boolean; detail: string }[] = [];
  for (const c of await ruleCandidates(rule)) {
    try {
      const t = await pickTemplate(c.id);
      const r = await generateForContent(c.id, templateRequest(t), actor, 'automation');
      results.push({ ref: c.ref, ok: true, detail: `${t.title}: filled ${r.filled.join(', ')}` });
    } catch (e) {
      results.push({ ref: c.ref, ok: false, detail: (e as Error).message });
      // An authorization or plan problem will fail every post the same way; stop here.
      if (e instanceof HttpError && e.status === 412) break;
    }
  }
  return { ran: true, reason: null, results };
}

// ---------- One-click bulk generation ----------

export interface BulkJob {
  running: boolean;
  started_at: string;
  finished_at: string | null;
  started_by: string;
  template: string;
  total: number;
  done: number;
  results: { ref: string; ok: boolean; detail: string }[];
}
let bulkJob: BulkJob | null = null;
export const bulkStatus = () => bulkJob;

/** Start generating graphics for every post that needs one. Returns at once; poll bulkStatus(). */
export async function startBulkGenerate(user: SessionUser) {
  if (bulkJob?.running) throw new HttpError(409, `Already generating (${bulkJob.done} of ${bulkJob.total} done).`);
  if (!(await canvaConnection())) throw new HttpError(412, 'Connect Canva first (Connections page).');
  await defaultTemplate(); // fails early, with a clear message, when there is no template at all
  const posts = await bulkCandidates();
  const job: BulkJob = { running: true, started_at: new Date().toISOString(), finished_at: null, started_by: user.name, template: 'matched to each post', total: posts.length, done: 0, results: [] };
  bulkJob = job;
  await audit({ actor: user, action: 'canva.bulk_generate', entityType: 'setting', entityId: 'canva_automation', next: { posts: posts.map((p) => p.ref) }, result: 'success' });
  void (async () => {
    for (const p of posts) {
      try {
        const t = await pickTemplate(p.id);
        const r = await generateForContent(p.id, templateRequest(t), user, 'bulk');
        job.results.push({ ref: p.ref, ok: r.brand_check?.status !== 'fail', detail: `${t.title}: filled ${r.filled.join(', ')}${r.brand_check ? ` · brand check ${r.brand_check.status}` : ''}` });
      } catch (e) {
        job.results.push({ ref: p.ref, ok: false, detail: (e as Error).message });
        if (e instanceof HttpError && e.status === 412) break;
      } finally {
        job.done++;
      }
    }
    job.running = false;
    job.finished_at = new Date().toISOString();
  })();
  return job;
}

// ---------- Graphics page ----------

/** Everything the Graphics page shows: templates, posts waiting for an image, and recent images. */
export async function graphicsOverview() {
  const conn = await canvaConnection();
  const rule = await getRule();
  const { rows: recent } = await query(
    `SELECT a.id, a.approved, a.created_at, a.label, a.url, a.brand_check, a.canva_design_id, c.id AS content_id, c.ref, c.title, c.scheduled_at, c.timezone
       FROM assets a JOIN content_items c ON c.id = a.content_id
      WHERE a.url ILIKE 'https://www.canva.com/%' AND a.data IS NOT NULL AND c.archived_at IS NULL
      ORDER BY a.created_at DESC LIMIT 24`,
  );
  const { canvaMcpConnection } = await import('./canvaMcp.js');
  const mcp = await canvaMcpConnection();
  const base = { connected: !!conn, account: conn?.account_name ?? null, automatic: rule.enabled, job: bulkJob, recent, brand_checks: !!mcp };
  if (!conn) return { ...base, templates: [], posts: [], default_template: null };
  const templates = await cachedTemplates().catch(() => [] as Template[]);
  const fallback = await defaultTemplate().catch(() => null);
  const posts = await Promise.all(
    (await bulkCandidates()).map(async (p) => ({ ...p, template: (await pickTemplate(p.id).catch(() => null))?.title ?? null })),
  );
  return {
    ...base,
    default_template: fallback ? { id: fallback.id, kind: fallback.kind, title: fallback.title } : null,
    templates: templates.map((t) => ({ ...t, keyword: templateKeyword(t.title), is_default: t.id === fallback?.id })),
    posts,
  };
}