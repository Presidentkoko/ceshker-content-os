import crypto from 'node:crypto';
import { query, tx } from '../db/pool.js';
import type { SessionUser } from '../../shared/domain.js';
import { open, seal } from './secretbox.js';
import { audit } from './audit.js';
import { HttpError } from '../http.js';

// Canva MCP (mcp.canva.com). Canva Connect (canva.ts) fills templates and exports images, but it
// cannot see or change the elements inside a design. The MCP server can, so Content OS uses it to
// keep formatting consistent:
//   - brand check: every Canva image is inspected; a known fake logo blocks approval
//   - logo fix:    fake logo elements are replaced with the approved logo, then re-exported
//
// The dashboard registers itself as an OAuth client (dynamic client registration) and an
// administrator approves it once. Tokens are stored encrypted, like the other providers.

const MCP_BASE = 'https://mcp.canva.com';
const MCP_URL = `${MCP_BASE}/mcp`;
const PROTOCOL = '2025-06-18';
export const CANVA_MCP_SCOPES = ['profile:read', 'design:meta:read', 'design:content:read', 'design:content:write', 'asset:read', 'brandkit:read'];

// Canva's MCP authorization server only redirects to its own known clients or to loopback
// addresses (the native-app pattern). The dashboard is hosted, so it uses a loopback redirect:
// after approving, the admin's browser shows an unreachable 127.0.0.1 page, and the admin pastes
// that address into the dashboard, which finishes the exchange with the PKCE verifier it kept.
export const canvaMcpRedirectUri = () => 'http://127.0.0.1:53682/content-os/canva-mcp/callback';

/** Pull the code and state out of the pasted loopback address. */
export function parsePastedRedirect(pasted: string) {
  let u: URL;
  try {
    u = new URL(pasted.trim());
  } catch {
    throw new HttpError(400, 'Paste the whole address from the browser bar (it starts with http://127.0.0.1).');
  }
  if (u.searchParams.get('error')) throw new HttpError(400, `Canva said: ${u.searchParams.get('error_description') ?? u.searchParams.get('error')}`);
  const code = u.searchParams.get('code');
  const state = u.searchParams.get('state');
  if (!code || !state) throw new HttpError(400, 'That address has no sign-in code. Click Allow in Canva first, then copy the address.');
  return { code, state };
}

// ---------- OAuth ----------

interface McpClient { client_id: string; client_secret?: string | null; redirect_uri: string }

/** The registered OAuth client for this deployment, registering one on first use. */
async function oauthClient(): Promise<McpClient> {
  const { rows } = await query(`SELECT value FROM settings WHERE key = 'canva_mcp_client'`);
  const saved = rows[0]?.value as McpClient | undefined;
  if (saved?.client_id && saved.redirect_uri === canvaMcpRedirectUri()) return saved;
  const res = await fetch(`${MCP_BASE}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Ceshker Content OS',
      redirect_uris: [canvaMcpRedirectUri()],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: CANVA_MCP_SCOPES.join(' '),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.client_id) throw new HttpError(502, `Canva MCP client registration failed: ${json.error_description ?? json.error ?? `HTTP ${res.status}`}`);
  const client: McpClient = { client_id: json.client_id, client_secret: json.client_secret ?? null, redirect_uri: canvaMcpRedirectUri() };
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ('canva_mcp_client', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(client)],
  );
  return client;
}

export async function canvaMcpAuthStart() {
  const client = await oauthClient();
  const state = crypto.randomBytes(24).toString('base64url');
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: client.redirect_uri,
    scope: CANVA_MCP_SCOPES.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: MCP_URL,
  });
  return { url: `${MCP_BASE}/authorize?${p}`, state, verifier };
}

async function tokenRequest(body: Record<string, string>) {
  const client = await oauthClient();
  const form: Record<string, string> = { ...body, client_id: client.client_id, resource: MCP_URL };
  if (client.client_secret) form.client_secret = client.client_secret;
  const res = await fetch(`${MCP_BASE}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(20_000),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) throw new Error(json.error_description ?? json.error ?? `Canva MCP token endpoint HTTP ${res.status}`);
  return json as { access_token: string; refresh_token?: string; expires_in?: number; scope?: string };
}

export async function completeCanvaMcpConsent(code: string, verifier: string, user: SessionUser) {
  const client = await oauthClient();
  const t = await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: client.redirect_uri });
  await query(
    `INSERT INTO oauth_tokens (provider, account_id, account_name, scopes, access_token_enc, refresh_token_enc, expires_at, connected_by)
     VALUES ('canva_mcp', NULL, $1, $2, $3, $4, $5, $6)
     ON CONFLICT (provider) DO UPDATE SET account_name = EXCLUDED.account_name, scopes = EXCLUDED.scopes,
       access_token_enc = EXCLUDED.access_token_enc, refresh_token_enc = EXCLUDED.refresh_token_enc,
       expires_at = EXCLUDED.expires_at, connected_by = EXCLUDED.connected_by, connected_at = now(), updated_at = now()`,
    [user.name, t.scope ?? CANVA_MCP_SCOPES.join(' '), seal(t.access_token), t.refresh_token ? seal(t.refresh_token) : null, new Date(Date.now() + (t.expires_in ?? 3600) * 1000), user.id],
  );
  // Prove the grant works before calling it connected.
  const tools = await listTools();
  await audit({ actor: user, action: 'oauth.canva_mcp.connect', entityType: 'connection', entityId: 'canva', next: { scopes: t.scope, tools: tools.length }, result: 'success' });
  return { tools: tools.length };
}

export async function canvaMcpConnection() {
  const { rows } = await query(`SELECT account_name, scopes, connected_at FROM oauth_tokens WHERE provider = 'canva_mcp'`);
  return (rows[0] as { account_name: string; scopes: string; connected_at: string } | undefined) ?? null;
}

async function accessToken(): Promise<string> {
  try {
    return await tx(async (client) => {
      const { rows } = await client.query(`SELECT * FROM oauth_tokens WHERE provider = 'canva_mcp' FOR UPDATE`);
      const row = rows[0];
      if (!row) throw new HttpError(412, 'Canva MCP is not connected. An administrator must click "Connect Canva MCP" on the Connections page.');
      if (new Date(row.expires_at).getTime() > Date.now() + 60_000) return open(row.access_token_enc);
      if (!row.refresh_token_enc) throw new Error('the grant expired and has no refresh token');
      const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: open(row.refresh_token_enc) });
      await client.query(
        `UPDATE oauth_tokens SET access_token_enc = $1, refresh_token_enc = COALESCE($2, refresh_token_enc), expires_at = $3, updated_at = now() WHERE provider = 'canva_mcp'`,
        [seal(t.access_token), t.refresh_token ? seal(t.refresh_token) : null, new Date(Date.now() + (t.expires_in ?? 3600) * 1000)],
      );
      return t.access_token;
    });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(412, `Canva MCP authorization failed: ${(e as Error).message}. Reconnect Canva MCP on the Connections page.`);
  }
}

export async function disconnectCanvaMcp(user: SessionUser) {
  await query(`DELETE FROM oauth_tokens WHERE provider = 'canva_mcp'`);
  await audit({ actor: user, action: 'oauth.canva_mcp.disconnect', entityType: 'connection', entityId: 'canva', result: 'success' });
}

// ---------- MCP client (Streamable HTTP, JSON-RPC) ----------

/** Read one JSON-RPC message with the given id from a JSON or SSE response. */
async function readMessage(res: Response, id: number): Promise<any> {
  const type = res.headers.get('content-type') ?? '';
  const text = await res.text();
  if (!type.includes('text/event-stream')) return text ? JSON.parse(text) : null;
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
    if (!data) continue;
    try {
      const msg = JSON.parse(data);
      if (msg.id === id) return msg;
    } catch {}
  }
  throw new Error('no response in the event stream');
}

type Call = (name: string, args: Record<string, unknown>) => Promise<any>;

/** Open an MCP session, run `fn` with a tool caller, then close the session. */
async function withSession<T>(fn: (call: Call, raw: (method: string, params?: unknown) => Promise<any>) => Promise<T>): Promise<T> {
  const token = await accessToken();
  let sessionId: string | null = null;
  let version = PROTOCOL;
  let next = 1;
  const post = async (payload: any) => {
    const res = await fetch(MCP_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': version,
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(90_000),
    });
    if (res.status === 401) throw new HttpError(412, 'Canva MCP rejected the saved grant. Reconnect Canva MCP on the Connections page.');
    sessionId = res.headers.get('mcp-session-id') ?? sessionId;
    return res;
  };
  const raw = async (method: string, params?: unknown) => {
    const id = next++;
    const res = await post({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
    if (!res.ok) throw new HttpError(502, `Canva MCP ${method}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const msg = await readMessage(res, id);
    if (msg?.error) throw new HttpError(502, `Canva MCP ${method}: ${msg.error.message ?? JSON.stringify(msg.error)}`);
    return msg?.result;
  };
  const init = await raw('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'ceshker-content-os', version: '1.0.0' } });
  version = init?.protocolVersion ?? PROTOCOL;
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const call: Call = async (name, args) => {
    const r = await raw('tools/call', { name, arguments: { user_intent: 'Content OS brand consistency check', ...args } });
    const text = (r?.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
    if (r?.isError) throw new HttpError(502, `Canva MCP ${name}: ${text.slice(0, 300) || 'tool error'}`);
    if (r?.structuredContent) return r.structuredContent;
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  };
  try {
    return await fn(call, raw);
  } finally {
    if (sessionId) {
      fetch(MCP_URL, { method: 'DELETE', headers: { authorization: `Bearer ${token}`, 'mcp-session-id': sessionId, 'mcp-protocol-version': version } }).catch(() => {});
    }
  }
}

export async function listTools(): Promise<string[]> {
  return withSession(async (_call, raw) => ((await raw('tools/list'))?.tools ?? []).map((t: any) => t.name));
}

/** Tool definitions (name, description, input schema) for the named tools, for diagnostics. */
export async function describeTools(names: string[]) {
  return withSession(async (_call, raw) => ((await raw('tools/list'))?.tools ?? []).filter((t: any) => !names.length || names.includes(t.name)));
}

/** Raw start-editing-transaction output for a design (always cancelled), for diagnostics. */
export async function inspectDesign(designId: string) {
  return withSession(async (call) => {
    const r = await call('start-editing-transaction', { design_id: designId });
    const txId = r?.transaction_id ?? r?.transaction?.transaction_id;
    if (txId) await call('cancel-editing-transaction', { transaction_id: txId }).catch(() => {});
    return r;
  });
}

export async function canvaMcpProbe() {
  const tools = await listTools();
  const needed = ['read-design', 'edit-design'];
  const missing = needed.filter((n) => !tools.includes(n));
  if (missing.length) throw new HttpError(502, `Canva MCP is missing tools: ${missing.join(', ')}. It offers: ${tools.join(', ') || 'none'}`);
  return `${tools.length} tools available`;
}

// ---------- Brand rules ----------

export interface BrandRules { approved_logo_asset_ids: string[]; blocked_asset_ids: string[]; logo_asset_for_fix: string | null }
const DEFAULT_RULES: BrandRules = { approved_logo_asset_ids: [], blocked_asset_ids: [], logo_asset_for_fix: null };

export async function getBrandRules(): Promise<BrandRules> {
  const { rows } = await query(`SELECT value FROM settings WHERE key = 'brand_rules'`);
  return { ...DEFAULT_RULES, ...(rows[0]?.value ?? {}) };
}

export async function setBrandRules(patch: Partial<BrandRules>, user: SessionUser) {
  const prev = await getBrandRules();
  const clean = (a?: string[]) => (a ? [...new Set(a.map((s) => s.trim()).filter((s) => /^M[A-Za-z0-9_-]{6,}$/.test(s)))] : undefined);
  const next: BrandRules = {
    approved_logo_asset_ids: clean(patch.approved_logo_asset_ids) ?? prev.approved_logo_asset_ids,
    blocked_asset_ids: clean(patch.blocked_asset_ids) ?? prev.blocked_asset_ids,
    logo_asset_for_fix: patch.logo_asset_for_fix !== undefined ? patch.logo_asset_for_fix : prev.logo_asset_for_fix,
  };
  await query(
    `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ('brand_rules', $1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [JSON.stringify(next), user.id],
  );
  await audit({ actor: user, action: 'brand.rules.update', entityType: 'setting', entityId: 'brand_rules', previous: prev, next, result: 'success' });
  return next;
}

// ---------- Design inspection ----------

interface Box { top: number; left: number; width: number; height: number }
interface Found { mediaId: string; locator: string | null; box: Box | null }
interface PageInfo { index: number; id: string; type: string; editable: boolean; media: Found[]; texts: { locator: string; text: string; box: Box; field: string | null }[] }

const boxOf = (o: any): Box | null =>
  typeof o?.top === 'number' && typeof o?.left === 'number' ? { top: o.top, left: o.left, width: o.width ?? 0, height: o.height ?? 0 } : null;

/** Every image/video and text box on each page, from read-design's structured content. */
function scanPages(content: any): PageInfo[] {
  const pages: any[] = content?.pages ?? [];
  return pages.map((p, i) => {
    const media: Found[] = [];
    const texts: PageInfo['texts'] = [];
    const walk = (o: any, owner: any) => {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) return o.forEach((x) => walk(x, owner));
      const el = o.locator_id ? o : owner;
      if (typeof o.mediaId === 'string') media.push({ mediaId: o.mediaId, locator: el?.locator_id ?? null, box: el === p ? null : boxOf(el) });
      if (o.locator_id && o.type === 'text' && Array.isArray(o.textRegions)) {
        const text = o.textRegions.map((r: any) => r.characters ?? '').join('').trim();
        const b = boxOf(o);
        if (b) texts.push({ locator: o.locator_id, text, box: b, field: o.dataFieldLabel ?? null });
      }
      for (const [k, v] of Object.entries(o)) if (k !== 'textRegions') walk(v, el);
    };
    walk(p, p);
    return { index: i + 1, id: p.id, type: p.type, editable: p.isEditable !== false, media, texts };
  });
}

export interface BrandCheck {
  status: 'pass' | 'fail' | 'review' | 'error';
  detail: string;
  found_approved: string[];
  found_blocked: string[];
  checked_at: string;
}

function judge(pages: PageInfo[], rules: BrandRules): BrandCheck {
  const ids = new Set(pages.flatMap((p) => p.media.map((m) => m.mediaId)));
  const found_blocked = rules.blocked_asset_ids.filter((x) => ids.has(x));
  const found_approved = rules.approved_logo_asset_ids.filter((x) => ids.has(x));
  const at = new Date().toISOString();
  if (found_blocked.length) return { status: 'fail', detail: 'Uses a logo that is not the approved Ceshker logo. Click "Fix logo" or edit the design in Canva.', found_approved, found_blocked, checked_at: at };
  if (found_approved.length) return { status: 'pass', detail: 'Uses the approved Ceshker logo.', found_approved, found_blocked, checked_at: at };
  return { status: 'review', detail: 'No approved logo found. Fine for celebration posts; otherwise check the design before approving.', found_approved, found_blocked, checked_at: at };
}

/** Open a read transaction, return the structured content, and always cancel the transaction. */
async function readStructured(call: Call, designId: string) {
  const r = await call('read-design', { design_id: designId, open_transaction: true, filter: { fields: ['design_content'] } });
  const txId = r?.transaction?.transaction_id ?? r?.transaction_id ?? null;
  return { content: r?.design_content, txId };
}

export async function checkDesign(designId: string): Promise<BrandCheck> {
  const rules = await getBrandRules();
  return withSession(async (call) => {
    const { content, txId } = await readStructured(call, designId);
    try {
      if (!content || typeof content !== 'object') throw new HttpError(502, 'Canva MCP returned no structured design content.');
      return judge(scanPages(content), rules);
    } finally {
      if (txId) await call('edit-design', { transaction_id: txId, finalize: 'cancel' }).catch(() => {});
    }
  });
}

const LOGO_RATIO = 225 / 63; // the approved logo file is 225 x 63
const LOGO_WORDS = /^(ceshker|group|ceshker\s+group)$/i;
const union = (bs: Box[]): Box => {
  const top = Math.min(...bs.map((b) => b.top));
  const left = Math.min(...bs.map((b) => b.left));
  return { top, left, width: Math.max(...bs.map((b) => b.left + b.width)) - left, height: Math.max(...bs.map((b) => b.top + b.height)) - top };
};

/**
 * Replace every blocked logo with the approved one. Also removes the loose "Ceshker"/"Group"
 * words that sat beside a fake mark (the approved logo already contains the name), then puts the
 * approved logo in the space they used. Saves the design in Canva.
 */
export async function fixDesignLogo(designId: string): Promise<{ changed: number; check: BrandCheck }> {
  const rules = await getBrandRules();
  if (!rules.logo_asset_for_fix) throw new HttpError(412, 'Set the approved logo asset for fixes in the brand rules first.');
  const blocked = new Set(rules.blocked_asset_ids);
  let changed = 0;
  await withSession(async (call) => {
    const { content, txId } = await readStructured(call, designId);
    if (!txId) throw new HttpError(502, 'Canva MCP did not open an editing transaction.');
    let committed = false;
    try {
      for (const page of scanPages(content)) {
        const bad = page.media.filter((m) => blocked.has(m.mediaId) && m.locator && m.box);
        if (!bad.length) continue;
        if (!page.editable || page.type === 'responsive') throw new HttpError(409, `Page ${page.index} cannot be edited automatically. Fix it in Canva.`);
        const ops: any[] = [];
        for (const b of bad) {
          const bb = b.box!;
          const words = page.texts.filter((t) => !t.field && LOGO_WORDS.test(t.text) && t.box.top >= bb.top - 150 && t.box.top <= bb.top + bb.height + 150 && Math.abs(t.box.left - bb.left) < 1400);
          const area = union([bb, ...words.map((w) => w.box)]);
          for (const loc of [b.locator!, ...words.map((w) => w.locator)]) ops.push({ type: 'delete_element', locator_id: loc });
          const height = area.height;
          const width = Math.round(height * LOGO_RATIO);
          const left = words.length ? area.left : Math.max(0, area.left + area.width / 2 - width / 2);
          ops.push({ type: 'insert_fill', page_id: page.id, asset_type: 'image', asset_id: rules.logo_asset_for_fix, alt_text: 'Ceshker Group Law and Title Professionals logo', top: area.top, left, width, height });
          changed++;
        }
        const seen = new Set<string>();
        const unique = ops.filter((o) => (o.type !== 'delete_element' ? true : !seen.has(o.locator_id) && (seen.add(o.locator_id), true)));
        await call('edit-design', { transaction_id: txId, page_index: page.index, finalize: 'keep_open', operations: unique });
      }
      if (changed) {
        await call('edit-design', { transaction_id: txId, finalize: 'commit' });
        committed = true;
      }
    } finally {
      if (!committed) await call('edit-design', { transaction_id: txId, finalize: 'cancel' }).catch(() => {});
    }
  });
  return { changed, check: await checkDesign(designId) };
}

// ---------- Assets ----------

/** A Canva design id for an asset: stored, or read from a canva.com/design/… link. */
function designIdFor(a: { canva_design_id: string | null; url: string }) {
  return a.canva_design_id ?? a.url.match(/canva\.com\/design\/(D[A-Za-z0-9_-]{8,})/)?.[1] ?? null;
}

async function saveCheck(assetId: string, check: BrandCheck) {
  await query(`UPDATE assets SET brand_check = $2 WHERE id = $1`, [assetId, JSON.stringify(check)]);
}

/**
 * Called after Content OS makes a Canva image. Records the design and runs the brand check when
 * Canva MCP is connected. Never throws: a failed check must not lose the generated image.
 */
export async function recordCanvaAsset(assetId: string, designId: string) {
  await query(`UPDATE assets SET canva_design_id = $2 WHERE id = $1`, [assetId, designId]);
  if (!(await canvaMcpConnection())) return null;
  try {
    const check = await checkDesign(designId);
    await saveCheck(assetId, check);
    return check;
  } catch (e) {
    const check: BrandCheck = { status: 'error', detail: `Brand check could not run: ${(e as Error).message}`, found_approved: [], found_blocked: [], checked_at: new Date().toISOString() };
    await saveCheck(assetId, check);
    return check;
  }
}

async function loadAsset(assetId: string) {
  const { rows } = await query(
    `SELECT a.id, a.url, a.label, a.canva_design_id, a.content_id, c.ref, c.publish_status FROM assets a LEFT JOIN content_items c ON c.id = a.content_id WHERE a.id = $1`,
    [assetId],
  );
  const a = rows[0];
  if (!a) throw new HttpError(404, 'Asset not found.');
  const designId = designIdFor(a);
  if (!designId) throw new HttpError(400, 'This image is not linked to a Canva design, so it cannot be checked in Canva.');
  return { ...a, designId } as { id: string; url: string; label: string | null; content_id: string; ref: string; publish_status: string; designId: string };
}

export async function checkAsset(assetId: string, user: SessionUser) {
  const a = await loadAsset(assetId);
  const check = await checkDesign(a.designId);
  await query(`UPDATE assets SET brand_check = $2, canva_design_id = $3 WHERE id = $1`, [assetId, JSON.stringify(check), a.designId]);
  await audit({ actor: user, action: 'brand.check', entityType: 'content', entityId: a.content_id, contentRef: a.ref, next: check, result: check.status === 'fail' ? 'failure' : 'success' });
  return check;
}

/**
 * Fix the logo in the asset's Canva design, export it again, attach the new image (unapproved,
 * with its brand check) and remove the old one.
 */
export async function fixAssetLogo(assetId: string, user: SessionUser) {
  const a = await loadAsset(assetId);
  if (a.publish_status === 'published') throw new HttpError(409, 'Published content is locked. Fix the design in Canva and repost.');
  const { changed, check } = await fixDesignLogo(a.designId);
  if (!changed) {
    await saveCheck(assetId, check);
    return { changed, check, asset: null };
  }
  const { exportDesignImage } = await import('./canva.js');
  const { storeGeneratedImage, removeAsset } = await import('./content.js');
  const img = await exportDesignImage(a.designId);
  const asset = await storeGeneratedImage(a.content_id, img, { url: a.url, label: (a.label ?? 'Canva image').replace(/( · logo fixed)?$/, ' · logo fixed').slice(0, 200) }, user);
  await query(`UPDATE assets SET canva_design_id = $2, brand_check = $3 WHERE id = $1`, [asset.id, a.designId, JSON.stringify(check)]);
  await removeAsset(assetId, user);
  await audit({ actor: user, action: 'brand.fix_logo', entityType: 'content', entityId: a.content_id, contentRef: a.ref, next: { design_id: a.designId, replaced: changed, new_asset: asset.id, check: check.status }, result: 'success' });
  return { changed, check, asset };
}

/**
 * Brand-check recent Canva images that have no check yet. Images made before design ids were
 * stored are matched to their design by title ("CT-0011 · …", as autofill names them).
 */
export async function checkRecentAssets(user: SessionUser, limit = 12) {
  const { rows } = await query(
    `SELECT a.id, a.url, a.canva_design_id, c.ref, c.title FROM assets a JOIN content_items c ON c.id = a.content_id
      WHERE a.kind = 'image' AND a.url ILIKE 'https://www.canva.com/%' AND c.archived_at IS NULL AND a.brand_check IS NULL
      ORDER BY a.created_at DESC LIMIT $1`,
    [limit],
  );
  const results: { ref: string; status: string; detail: string }[] = [];
  for (const a of rows as { id: string; url: string; canva_design_id: string | null; ref: string; title: string }[]) {
    try {
      let designId = designIdFor(a);
      if (!designId) {
        const found = await withSession((call) => call('search-designs', { query: a.ref, sort_by: 'relevance', limit: 10 }));
        const prefix = `${a.ref} ·`;
        const matches = (found?.items ?? []).filter((d: any) => typeof d.title === 'string' && d.title.startsWith(prefix));
        if (matches.length !== 1) {
          results.push({ ref: a.ref, status: 'skipped', detail: matches.length ? 'More than one matching design' : 'No matching Canva design' });
          continue;
        }
        designId = matches[0].id as string;
        await query(`UPDATE assets SET canva_design_id = $2 WHERE id = $1`, [a.id, designId]);
      }
      const check = await checkDesign(designId!);
      await saveCheck(a.id, check);
      results.push({ ref: a.ref, status: check.status, detail: check.detail });
    } catch (e) {
      results.push({ ref: a.ref, status: 'error', detail: (e as Error).message });
      if (e instanceof HttpError && e.status === 412) break;
    }
  }
  await audit({ actor: user, action: 'brand.check_recent', entityType: 'setting', entityId: 'brand_rules', next: { results }, result: 'success' });
  return { checked: results.length, results };
}

export const __test = { scanPages, judge };
