import { query } from '../db/pool.js';
import { brand, driveFolderId } from '../brand.js';
import { config } from '../config.js';
import type { ConnectionKey, SessionUser } from '../../shared/domain.js';
import type { ConnectionState } from '../../shared/validation.js';
import { callN8n, n8nConfigured, n8nHealth } from './n8n.js';
import { driveFolderProbe, serviceAccount, serviceAccountEmail } from './google.js';
import { audit } from './audit.js';
import { HttpError } from '../http.js';
import { sheetCsvUrl } from './sheetSync.js';
import { allowedChannels, currentConnectInvite, googleConnection, oauthConfigured, redirectUri, youtubeChannels } from './googleOAuth.js';
import { metaPages, metaTokenConfigured } from './meta.js';
import { canvaConfigured, canvaConnection, canvaRedirectUri, getRule } from './canva.js';
import { canvaMcpConnection } from './canvaMcp.js';

interface ConnectionMeta {
  key: ConnectionKey;
  label: string;
  purpose: string;
  permissions: string[];
  /** Platforms whose automation can be switched on once this connection is live. */
  automatable: boolean;
  setup: string;
}

export const CONNECTIONS: ConnectionMeta[] = [
  {
    key: 'google_drive',
    label: 'Google Drive',
    purpose: `Reads ${brand.videoBrand} final videos, thumbnails and approved graphics.`,
    permissions: [`${brand.videoBrand} folder shared "Anyone with the link" (Viewer)`, 'Optional: a service account added as Viewer, if the folder is made private'],
    automatable: false,
    setup: 'Set DRIVE_FOLDER_ID (and optionally GOOGLE_SERVICE_ACCOUNT_JSON), then share the folder with the service-account email.',
  },
  {
    key: 'google_sheets',
    label: 'Google Sheets',
    purpose: `Planning source: the ${brand.name} content database sheet is imported on demand.`,
    permissions: ['Sheet viewable by link (CSV import)', 'or spreadsheets.readonly via the service account (also imports hyperlinks)'],
    automatable: false,
    setup: 'Set GOOGLE_SHEET_ID and GOOGLE_SHEET_GID.',
  },
  {
    key: 'youtube',
    label: 'YouTube',
    purpose: `Uploads ${brand.videoBrand} videos, sets titles, descriptions, thumbnails, playlists and release times.`,
    permissions: ['YouTube Data API v3 enabled in the Google Cloud project', 'OAuth scopes youtube and youtube.upload (videos are read from the link-shared Drive folder)', 'Channel owner or manager approves the consent screen'],
    automatable: true,
    setup: 'Create a Google Cloud OAuth client (Web application) with the redirect URI shown below, set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in Railway, then click Connect YouTube.',
  },
  {
    key: 'facebook',
    label: 'Facebook Page',
    purpose: 'Publishes feed posts, photos, videos and Stories to the enabled Facebook Pages.',
    permissions: [`Business app linked to ${brand.metaBusiness}`, 'System user (Admin) with the Pages assigned', 'Token scopes: pages_show_list, pages_read_engagement, pages_manage_posts, business_management'],
    automatable: true,
    setup: 'Set META_SYSTEM_USER_TOKEN in Railway, then refresh the Page list below and enable the Pages to post to.',
  },
  {
    key: 'instagram',
    label: 'Instagram professional account',
    purpose: 'Publishes feed posts, carousels, Reels and Stories to the Instagram accounts linked to the enabled Pages.',
    permissions: ['Instagram professional account linked to its Facebook Page', 'Token scopes: instagram_basic, instagram_content_publish'],
    automatable: true,
    setup: 'Uses the same system-user token as Facebook. Enable a Page that has a linked Instagram account.',
  },
  {
    key: 'canva',
    label: 'Canva',
    purpose: `Generates post graphics: autofills a ${brand.name} brand template with the post’s text, or exports an existing design, and stores the PNG on the post for approval.`,
    permissions: ['Canva Connect integration (Developer Portal) with scopes profile:read, design:meta:read, design:content:read/write, brandtemplate:meta:read, brandtemplate:content:read', 'Brand templates and autofill need Canva Pro, Teams or Enterprise', 'A team member approves the consent screen'],
    automatable: false,
    setup: 'Create an integration in the Canva Developer Portal with the redirect URL shown below, set CANVA_CLIENT_ID and CANVA_CLIENT_SECRET in Railway, then click Connect Canva.',
  },
  {
    key: 'n8n',
    label: 'n8n',
    purpose: 'Runs integrations, scheduled processes, reconciliation and publishing workflows.',
    permissions: ['Webhook reachable from the dashboard', 'Shared HMAC secret for signed requests'],
    automatable: false,
    setup: 'Set N8N_BASE_URL, N8N_PUBLISH_WEBHOOK_URL, N8N_WEBHOOK_SECRET and N8N_CALLBACK_SECRET.',
  },
  {
    key: 'postgres',
    label: 'PostgreSQL',
    purpose: `Application state, audit history and idempotency (schema "${config.DB_SCHEMA}").`,
    permissions: ['CREATE on the database (first migration only)', 'Read/write on its own schema'],
    automatable: false,
    setup: 'Set DATABASE_URL (use the Railway reference variable).',
  },
  {
    key: 'railway',
    label: 'Railway service health',
    purpose: 'Hosting for the dashboard service alongside n8n and PostgreSQL.',
    permissions: ['Dashboard deployed as its own service'],
    automatable: false,
    setup: 'Deploy this repository as a new Railway service in the existing project.',
  },
];

const PLATFORM_KEYS = ['youtube', 'facebook', 'instagram'] as const;

export async function ensureConnectionRows() {
  for (const c of CONNECTIONS) {
    await query('INSERT INTO connections (key, label) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label', [c.key, c.label]);
  }
}

// Whether the owner has completed "Connect YouTube" (Google OAuth). Refreshed before each check.
let googleLinked = false;
let canvaLinked = false;
// Enabled Meta Pages (refreshed alongside the Google state).
let metaState = { enabled: 0, hasDefault: false, igEnabled: 0 };
export async function refreshGoogleLinked() {
  googleLinked = !!(await query(`SELECT 1 FROM youtube_channels WHERE is_primary`)).rowCount;
  canvaLinked = !!(await query(`SELECT 1 FROM oauth_tokens WHERE provider = 'canva'`)).rowCount;
  const m = (await query(`SELECT count(*) FILTER (WHERE enabled) AS enabled, bool_or(is_default) AS has_default,
      count(*) FILTER (WHERE enabled AND ig_user_id IS NOT NULL) AS ig FROM meta_pages`)).rows[0];
  metaState = { enabled: m.enabled, hasDefault: !!m.has_default, igEnabled: m.ig };
  return googleLinked;
}

/** Why a connection cannot be tested or used yet; null when it is configured. */
export function configurationBlocker(key: ConnectionKey): string | null {
  switch (key) {
    case 'google_drive':
      // Works through the folder's "anyone with the link" share; a service account is optional.
      if (!driveFolderId()) return 'Needs DRIVE_FOLDER_ID.';
      return null;
    case 'google_sheets':
      return config.GOOGLE_SHEET_ID ? null : 'Needs GOOGLE_SHEET_ID.';
    case 'n8n':
      return config.N8N_BASE_URL || config.N8N_PUBLISH_WEBHOOK_URL ? null : 'Needs N8N_BASE_URL and N8N_PUBLISH_WEBHOOK_URL.';
    case 'youtube':
      if (!oauthConfigured()) return 'Needs a Google Cloud OAuth client: set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in Railway.';
      if (!googleLinked) return `Click "Connect YouTube" and approve access with ${brand.youtubeOwner}.`;
      return null;
    case 'facebook':
    case 'instagram':
      if (!metaTokenConfigured()) return `Needs META_SYSTEM_USER_TOKEN in Railway: a system-user token from ${brand.metaBusiness} settings.`;
      if (!metaState.enabled) return 'Refresh the Page list on the Facebook card and enable at least one Page.';
      if (!metaState.hasDefault) return 'Choose a default Page on the Facebook card.';
      if (key === 'instagram' && !metaState.igEnabled) return 'None of the enabled Pages has a linked Instagram professional account.';
      return null;
    case 'canva':
      if (!canvaConfigured()) return 'Needs a Canva Connect integration: set CANVA_CLIENT_ID and CANVA_CLIENT_SECRET in Railway.';
      if (!canvaLinked) return `Click "Connect Canva" and approve access with the ${brand.canvaTeam}.`;
      return null;
    default:
      return null;
  }
}

async function probe(key: ConnectionKey): Promise<{ ok: boolean; error: string | null; detail?: string; executionId?: string | null }> {
  switch (key) {
    case 'postgres': {
      const r = await query('SELECT version() AS v');
      return { ok: true, error: null, detail: String(r.rows[0].v).split(',')[0] };
    }
    case 'railway':
      return config.RAILWAY_ENVIRONMENT_NAME
        ? { ok: true, error: null, detail: `${config.RAILWAY_SERVICE_NAME ?? 'service'} @ ${config.RAILWAY_ENVIRONMENT_NAME}${config.RAILWAY_GIT_COMMIT_SHA ? ' · ' + config.RAILWAY_GIT_COMMIT_SHA.slice(0, 7) : ''}` }
        : { ok: false, error: 'Not running on Railway (local or other host).' };
    case 'n8n': {
      const h = await n8nHealth();
      if (!h.ok) return h;
      if (!n8nConfigured()) return { ok: false, error: 'n8n is up but N8N_PUBLISH_WEBHOOK_URL is not set.' };
      const r = await callN8n({ action: 'ping', source: 'content-os', at: new Date().toISOString() }, 10_000);
      return { ok: r.ok, error: r.error, executionId: r.executionId };
    }
    case 'google_sheets': {
      const res = await fetch(sheetCsvUrl(), { signal: AbortSignal.timeout(15_000) });
      const text = await res.text();
      if (!res.ok || text.startsWith('<')) return { ok: false, error: `Sheet not readable (HTTP ${res.status}). Make it viewable by link or grant the service account access.` };
      return { ok: true, error: null, detail: `${text.split('\n').length} lines readable` };
    }
    case 'google_drive': {
      if (serviceAccount()) {
        const f = await driveFolderProbe(driveFolderId()!);
        return { ok: true, error: null, detail: `Folder "${f.name}" readable by ${serviceAccountEmail()}` };
      }
      const { listPublicTree } = await import('./drivePublic.js');
      const entries = await listPublicTree(driveFolderId()!, 0);
      return { ok: true, error: null, detail: `Link-shared folder readable (${entries.length} top-level items)` };
    }
    case 'youtube': {
      const { channelSummary } = await import('./youtube.js');
      const c = await channelSummary();
      const allowed = allowedChannels();
      if (allowed.length && !allowed.includes(c.id)) return { ok: false, error: `Connected to "${c.title}" (${c.id}), which is not one of this dashboard's channels.` };
      return { ok: true, error: null, detail: `${c.title} · ${c.videos} videos · ${c.subscribers.toLocaleString()} subscribers` };
    }
    case 'facebook':
    case 'instagram': {
      const { probe: metaProbe } = await import('./meta.js');
      return { ok: true, error: null, detail: await metaProbe(key) };
    }
    case 'canva': {
      const { canvaProbe } = await import('./canva.js');
      return { ok: true, error: null, detail: await canvaProbe() };
    }
  }
}

export async function testConnection(key: ConnectionKey, user: SessionUser | null) {
  await refreshGoogleLinked();
  const blocker = configurationBlocker(key);
  if (blocker) {
    await query(`UPDATE connections SET status = 'not_configured', last_checked_at = now() WHERE key = $1`, [key]);
    throw new HttpError(412, blocker);
  }
  const { rows: run } = await query(
    `INSERT INTO workflow_runs (kind, summary, triggered_by, request) VALUES ('connection_test', $1, $2, $3) RETURNING id`,
    [`Test ${key}`, user?.id ?? null, JSON.stringify({ key })],
  );
  let result: Awaited<ReturnType<typeof probe>>;
  try {
    result = await probe(key);
  } catch (e) {
    result = { ok: false, error: (e as Error).message };
  }
  await query(
    `UPDATE workflow_runs SET status = $2, finished_at = now(), error = $3, execution_id = $4, response = $5 WHERE id = $1`,
    [run[0].id, result.ok ? 'succeeded' : 'failed', result.error, result.executionId ?? null, JSON.stringify({ detail: result.detail ?? null })],
  );
  if (result.ok) {
    await query(`UPDATE connections SET status = 'connected', last_success_at = now(), last_checked_at = now() WHERE key = $1`, [key]);
  } else {
    // A failed test also switches platform automation off, so nothing publishes against a broken connection.
    await query(
      `UPDATE connections SET status = 'disconnected', last_error = $2, last_error_at = now(), last_checked_at = now(),
         automation_enabled = CASE WHEN automation_enabled THEN false ELSE automation_enabled END WHERE key = $1`,
      [key, result.error],
    );
  }
  if (user) {
    await audit({ actor: user, action: 'connection.test', entityType: 'connection', entityId: key, executionId: result.executionId ?? null, result: result.ok ? 'success' : 'failure', detail: result.ok ? result.detail ?? null : result.error });
  }
  return { ok: result.ok, error: result.error, detail: result.detail ?? null };
}

export async function listConnections() {
  await refreshGoogleLinked();
  const google = await googleConnection();
  const canvaLink = await canvaConnection();
  const ytInvite = await currentConnectInvite();
  const ytChannels = await youtubeChannels();
  const canvaRule = await getRule();
  const canvaMcpLink = await canvaMcpConnection();
  const pages = await metaPages();
  const enabledPages = pages.filter((p) => p.enabled);
  const { rows } = await query('SELECT * FROM connections');
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return CONNECTIONS.map((meta) => {
    const row = byKey.get(meta.key) ?? {};
    const blocker = configurationBlocker(meta.key);
    return {
      ...meta,
      status: blocker ? 'not_configured' : row.status ?? 'unknown',
      last_success_at: row.last_success_at ?? null,
      last_checked_at: row.last_checked_at ?? null,
      last_error: row.last_error ?? null,
      last_error_at: row.last_error_at ?? null,
      automation_enabled: !!row.automation_enabled,
      automation_changed_at: row.automation_changed_at ?? null,
      blocker,
      // Only non-secret identifiers, and even those are masked.
      identity:
        meta.key === 'youtube' && google ? `Channel ${google.account_name}`
        : meta.key === 'facebook' && enabledPages.length ? enabledPages.map((p) => p.name + (p.is_default ? ' (default)' : '')).join(', ')
        : meta.key === 'canva' && canvaLink ? `Canva user ${canvaLink.account_name}`
        : meta.key === 'instagram' && enabledPages.some((p) => p.ig_username) ? enabledPages.filter((p) => p.ig_username).map((p) => '@' + p.ig_username).join(', ')
        : identityFor(meta.key),
      meta: meta.key === 'facebook' ? { token_configured: metaTokenConfigured(), pages } : undefined,
      canva: meta.key === 'canva' ? { configured: canvaConfigured(), connected: !!canvaLink, account: canvaLink?.account_name ?? null, connected_at: canvaLink?.connected_at ?? null, redirect_uri: canvaRedirectUri(), rule: { enabled: canvaRule.enabled, template_title: canvaRule.template_title }, mcp: canvaMcpLink ? { connected: true, connected_by: canvaMcpLink.account_name, connected_at: canvaMcpLink.connected_at } : { connected: false } } : undefined,
      oauth: meta.key === 'youtube' ? { configured: oauthConfigured(), connected: !!google, channel: google?.account_name ?? null, connected_at: google?.connected_at ?? null, redirect_uri: redirectUri(), invite: ytInvite, channels: ytChannels } : undefined,
    };
  });
}

function mask(v: string | undefined | null) {
  if (!v) return null;
  return v.length <= 6 ? '••••' : `${v.slice(0, 3)}••••${v.slice(-3)}`;
}

function identityFor(key: ConnectionKey): string | null {
  switch (key) {
    case 'google_drive':
      return serviceAccountEmail() ? `Service account ${serviceAccountEmail()}` : null;
    case 'google_sheets':
      return config.GOOGLE_SHEET_ID ? `Sheet ${mask(config.GOOGLE_SHEET_ID)}` : null;
    case 'facebook':
    case 'instagram':
    case 'canva':
      return null;
    case 'youtube':
      return config.YOUTUBE_CHANNEL_ID ? `Channel ${mask(config.YOUTUBE_CHANNEL_ID)}` : null;
    case 'n8n':
      return config.N8N_BASE_URL ? new URL(config.N8N_BASE_URL).host : null;
    case 'postgres':
      return `schema ${config.DB_SCHEMA}`;
    case 'railway':
      return config.RAILWAY_ENVIRONMENT_NAME ?? null;
  }
}

/** Administrator-only switch. Requires a successful test in the last 24 hours. */
export async function setAutomation(key: ConnectionKey, enabled: boolean, user: SessionUser) {
  const meta = CONNECTIONS.find((c) => c.key === key);
  if (!meta?.automatable) throw new HttpError(400, 'This connection has no publishing automation.');
  await refreshGoogleLinked();
  const { rows } = await query('SELECT * FROM connections WHERE key = $1', [key]);
  const row = rows[0];
  if (enabled) {
    const blocker = configurationBlocker(key);
    if (blocker) throw new HttpError(412, blocker);
    const fresh = row?.status === 'connected' && row.last_success_at && Date.now() - new Date(row.last_success_at).getTime() < 86_400_000;
    if (!fresh) throw new HttpError(412, 'Run a successful connection test (within the last 24 hours) before enabling automation.');
  }
  await query('UPDATE connections SET automation_enabled = $2, automation_changed_by = $3, automation_changed_at = now() WHERE key = $1', [key, enabled, user.id]);
  await audit({ actor: user, action: enabled ? 'automation.enable' : 'automation.disable', entityType: 'connection', entityId: key, previous: { automation_enabled: !!row?.automation_enabled }, next: { automation_enabled: enabled }, result: 'success' });
}

export async function platformConnectionState(): Promise<ConnectionState> {
  await refreshGoogleLinked();
  const { rows } = await query(`SELECT key, status, automation_enabled FROM connections WHERE key = ANY($1)`, [PLATFORM_KEYS]);
  const state: ConnectionState = {};
  for (const r of rows) {
    const configured = !configurationBlocker(r.key);
    state[r.key] = { connected: configured && r.status === 'connected', automationEnabled: configured && r.automation_enabled };
  }
  return state;
}
