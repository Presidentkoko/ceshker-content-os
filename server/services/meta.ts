import crypto from 'node:crypto';
import { query } from '../db/pool.js';
import { config } from '../config.js';
import type { SessionUser } from '../../shared/domain.js';
import { audit } from './audit.js';
import { HttpError } from '../http.js';
import { publicBaseUrl } from './googleOAuth.js';

// Direct Facebook Page + Instagram publishing with a Business "system user" token.
// The token lives only in the Railway variable META_SYSTEM_USER_TOKEN and is never returned.

const VERSION = () => process.env.META_GRAPH_VERSION || 'v23.0';
const GRAPH = () => `https://graph.facebook.com/${VERSION()}`;

export const metaTokenConfigured = () => !!process.env.META_SYSTEM_USER_TOKEN;

export interface MetaPage {
  page_id: string;
  name: string;
  ig_user_id: string | null;
  ig_username: string | null;
  can_post: boolean;
  enabled: boolean;
  is_default: boolean;
}

export async function metaPages(onlyEnabled = false): Promise<MetaPage[]> {
  const { rows } = await query(`SELECT * FROM meta_pages ${onlyEnabled ? 'WHERE enabled' : ''} ORDER BY is_default DESC, name`);
  return rows;
}

/**
 * Resolve a destination to a concrete Page (and Instagram account). account_id is a Page id for
 * Facebook or an Instagram user id for Instagram; null means the default Page.
 */
export async function resolveAccount(platform: 'facebook' | 'instagram', accountId: string | null) {
  const pages = await metaPages(true);
  const page = accountId
    ? pages.find((p) => (platform === 'facebook' ? p.page_id === accountId : p.ig_user_id === accountId))
    : pages.find((p) => p.is_default);
  if (!page) {
    throw new HttpError(412, accountId
      ? 'The chosen Page is not enabled for publishing. Enable it on the Connections page.'
      : 'No default Facebook Page is set. Choose one on the Connections page.');
  }
  if (platform === 'instagram' && !page.ig_user_id) throw new HttpError(412, `"${page.name}" has no linked Instagram professional account.`);
  return page;
}
async function graph(path: string, opts: { token?: string; method?: 'GET' | 'POST'; params?: Record<string, string | undefined> } = {}) {
  const token = opts.token ?? process.env.META_SYSTEM_USER_TOKEN;
  if (!token) throw new HttpError(412, 'META_SYSTEM_USER_TOKEN is not set in Railway.');
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.params ?? {})) if (v !== undefined) params.set(k, v);
  params.set('access_token', token);
  const method = opts.method ?? 'GET';
  const url = `${GRAPH()}${path}${method === 'GET' ? `?${params}` : ''}`;
  const res = await fetch(url, {
    method,
    headers: method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : undefined,
    body: method === 'POST' ? params : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const e = json.error ?? {};
    const hint =
      e.code === 190 ? ' The token is invalid or was revoked; generate a new system-user token.' :
      e.code === 10 || e.code === 200 ? ' The token is missing a permission; regenerate it with pages_manage_posts, instagram_content_publish and the other listed permissions.' :
      e.code === 4 || e.code === 17 || e.code === 32 ? ' Meta rate limit reached; the dispatcher will retry on the next attempt.' : '';
    throw new HttpError(502, `Meta: ${e.message ?? `HTTP ${res.status}`}${hint}`, { code: e.code, subcode: e.error_subcode, fbtrace_id: e.fbtrace_id });
  }
  return json;
}

// Page tokens derived from a non-expiring system-user token do not expire; cache per process.
const pageTokens = new Map<string, string>();
async function pageToken(pageId: string) {
  const hit = pageTokens.get(pageId);
  if (hit) return hit;
  const j = await graph(`/${pageId}`, { params: { fields: 'access_token' } });
  if (!j.access_token) throw new HttpError(412, 'The system user is not assigned to this Page. In Business Settings → System users → Assign assets, give it full control of the Page.');
  pageTokens.set(pageId, j.access_token);
  return j.access_token as string;
}

/** Pages the system user can manage, each with its linked Instagram professional account. */
export async function listPages() {
  const j = await graph('/me/accounts', { params: { fields: 'id,name,tasks,instagram_business_account{id,username}', limit: '100' } });
  return (j.data ?? []).map((p: any) => ({
    id: p.id as string,
    name: p.name as string,
    can_post: Array.isArray(p.tasks) ? p.tasks.includes('CREATE_CONTENT') || p.tasks.includes('MANAGE') : true,
    instagram: p.instagram_business_account ? { id: p.instagram_business_account.id as string, username: p.instagram_business_account.username as string } : null,
  }));
}

/** Refresh the Page list from Meta. Keeps each Page's enabled/default choice; new Pages start disabled. */
export async function syncPages(user: SessionUser) {
  const pages = await listPages();
  for (const p of pages) {
    await query(
      `INSERT INTO meta_pages (page_id, name, ig_user_id, ig_username, can_post, synced_at)
       VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (page_id) DO UPDATE SET name = EXCLUDED.name, ig_user_id = EXCLUDED.ig_user_id,
         ig_username = EXCLUDED.ig_username, can_post = EXCLUDED.can_post, synced_at = now()`,
      [p.id, p.name, p.instagram?.id ?? null, p.instagram?.username ?? null, p.can_post],
    );
  }
  // Pages the system user lost access to cannot be published to.
  await query(`UPDATE meta_pages SET enabled = false, is_default = false WHERE NOT (page_id = ANY($1))`, [pages.map((p: any) => p.id)]);
  pageTokens.clear();
  await audit({ actor: user, action: 'meta.sync_pages', entityType: 'connection', entityId: 'facebook', next: { pages: pages.map((p: any) => p.name) }, result: 'success' });
  return metaPages();
}

/** Enable/disable a Page for publishing, or make it the default. Resets platform automation for safety. */
export async function updatePage(pageId: string, patch: { enabled?: boolean; is_default?: boolean }, user: SessionUser) {
  const { rows } = await query('SELECT * FROM meta_pages WHERE page_id = $1', [pageId]);
  const before = rows[0];
  if (!before) throw new HttpError(404, 'Page not found. Refresh the Page list first.');
  if (patch.enabled && !before.can_post) throw new HttpError(412, 'The system user cannot create content on this Page. Give it full control in Business Settings.');
  const enabled = patch.is_default ? true : patch.enabled ?? before.enabled;
  if (patch.is_default) await query('UPDATE meta_pages SET is_default = false WHERE is_default');
  await query('UPDATE meta_pages SET enabled = $2, is_default = $3 WHERE page_id = $1', [pageId, enabled, enabled ? patch.is_default ?? before.is_default : false]);
  // Changing where posts can go requires the administrator to re-approve automation.
  await query(`UPDATE connections SET automation_enabled = false WHERE key IN ('facebook','instagram') AND automation_enabled`);
  await audit({ actor: user, action: 'meta.update_page', entityType: 'connection', entityId: pageId, previous: { enabled: before.enabled, is_default: before.is_default }, next: { enabled, is_default: patch.is_default ?? before.is_default }, result: 'success', detail: before.name });
  return metaPages();
}

/** Read-only identity check used by the connection "Safe test": every enabled Page (or its Instagram). */
export async function probe(which: 'facebook' | 'instagram') {
  const pages = (await metaPages(true)).filter((p) => which === 'facebook' || p.ig_user_id);
  if (!pages.length) throw new HttpError(412, which === 'facebook' ? 'Enable at least one Page on the Connections page.' : 'No enabled Page has a linked Instagram professional account.');
  if (!pages.some((p) => p.is_default)) throw new HttpError(412, 'Choose a default Page on the Connections page.');
  const out: string[] = [];
  for (const page of pages) {
    const token = await pageToken(page.page_id);
    if (which === 'facebook') {
      const p = await graph(`/${page.page_id}`, { token, params: { fields: 'name,fan_count' } });
      out.push(`${p.name} (${Number(p.fan_count ?? 0).toLocaleString()} followers)`);
    } else {
      const ig = await graph(`/${page.ig_user_id}`, { token, params: { fields: 'username,followers_count' } });
      const limit = await graph(`/${page.ig_user_id}/content_publishing_limit`, { token, params: { fields: 'quota_usage,config' } }).catch(() => null);
      const quota = limit?.data?.[0] ? `, ${limit.data[0].quota_usage}/${limit.data[0].config?.quota_total ?? '?'} posts used today` : '';
      out.push(`@${ig.username} (${Number(ig.followers_count ?? 0).toLocaleString()} followers${quota})`);
    }
  }
  return out.join(' · ');
}

// ---------- Signed media links (Meta fetches media by URL) ----------

const mediaKey = () => crypto.createHash('sha256').update(`media:${config.SESSION_SECRET}`).digest();

/** fmt: 'orig' passes the file through; 'jpeg' converts images; 'feed' also pads to Instagram's 4:5–1.91:1 range. */
export function signedMediaUrl(assetId: string, opts: { jpeg?: boolean; feed?: boolean; ttlSeconds?: number } = {}) {
  const exp = Math.floor(Date.now() / 1000) + (opts.ttlSeconds ?? 3 * 3600);
  const fmt = opts.feed ? 'feed' : opts.jpeg ? 'jpeg' : 'orig';
  const sig = crypto.createHmac('sha256', mediaKey()).update(`${assetId}.${exp}.${fmt}`).digest('base64url');
  return `${publicBaseUrl()}/media/${assetId}.${fmt === 'orig' ? 'bin' : 'jpg'}?exp=${exp}&fmt=${fmt}&sig=${sig}`;
}

export function verifyMediaSignature(assetId: string, exp: string, fmt: string, sig: string) {
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now() / 1000) return false;
  const expected = crypto.createHmac('sha256', mediaKey()).update(`${assetId}.${exp}.${fmt}`).digest('base64url');
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

// ---------- Publishing ----------

export interface MetaMedia {
  id: string;
  kind: 'image' | 'video';
}

export interface MetaPublishInput {
  platform: 'facebook' | 'instagram';
  placement: string;
  account_id: string | null;
  message: string;
  media: MetaMedia[];
}

async function waitForContainer(containerId: string, token: string) {
  // Video containers are processed asynchronously by Instagram; poll up to ~5 minutes.
  for (let i = 0; i < 60; i++) {
    const s = await graph(`/${containerId}`, { token, params: { fields: 'status_code,status' } });
    if (s.status_code === 'FINISHED') return;
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new HttpError(502, `Instagram could not process the media: ${s.status ?? s.status_code}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new HttpError(504, 'Instagram is still processing the video after 5 minutes. Retry later.');
}

/**
 * Private end-to-end test: exercises the token, permissions and media transfer without anything
 * becoming visible. Facebook: an unpublished Page photo. Instagram: a media container that is
 * checked by Meta but never published (Meta discards it within 24 hours).
 */
export async function privateTest(assetId: string, caption: string, user: SessionUser) {
  const page = await resolveAccount('facebook', null);
  const token = await pageToken(page.page_id);
  const out: Record<string, unknown> = { page: page.name };
  const fb = await graph(`/${page.page_id}/photos`, {
    token, method: 'POST',
    params: { url: signedMediaUrl(assetId, { jpeg: true }), caption, published: 'false' },
  });
  out.facebook = { ok: true, unpublished_photo_id: fb.id, visible_to_public: false };
  if (page.ig_user_id) {
    const c = await graph(`/${page.ig_user_id}/media`, { token, method: 'POST', params: { image_url: signedMediaUrl(assetId, { feed: true }), caption } });
    let status = 'IN_PROGRESS';
    for (let i = 0; i < 24 && status === 'IN_PROGRESS'; i++) {
      await new Promise((r) => setTimeout(r, 2500));
      status = (await graph(`/${c.id}`, { token, params: { fields: 'status_code' } })).status_code;
    }
    out.instagram = { ok: status === 'FINISHED', account: `@${page.ig_username}`, container_id: c.id, container_status: status, published: false };
  }
  await audit({ actor: user, action: 'meta.private_test', entityType: 'connection', entityId: page.page_id, next: out, result: 'success' });
  return out;
}

/** Publish one destination. Returns the platform post id and public URL. */
export async function publish(input: MetaPublishInput): Promise<{ id: string; url: string | null }> {
  const page = await resolveAccount(input.platform, input.account_id);
  const sel = page;
  const token = await pageToken(page.page_id);
  const images = input.media.filter((m) => m.kind === 'image');
  const video = input.media.find((m) => m.kind === 'video');

  if (input.platform === 'facebook') {
    if (input.placement === 'story') {
      if (!images[0]) throw new HttpError(400, 'Facebook Stories from the dashboard need an image.');
      const photo = await graph(`/${sel.page_id}/photos`, { token, method: 'POST', params: { url: signedMediaUrl(images[0].id, { jpeg: true }), published: 'false' } });
      const story = await graph(`/${sel.page_id}/photo_stories`, { token, method: 'POST', params: { photo_id: photo.id } });
      return { id: String(story.post_id ?? story.id ?? photo.id), url: null };
    }
    if (video) {
      const v = await graph(`/${sel.page_id}/videos`, { token, method: 'POST', params: { file_url: signedMediaUrl(video.id), description: input.message } });
      return { id: String(v.id), url: `https://www.facebook.com/${sel.page_id}/videos/${v.id}` };
    }
    if (images.length > 1) {
      const ids: string[] = [];
      for (const img of images.slice(0, 10)) {
        const p = await graph(`/${sel.page_id}/photos`, { token, method: 'POST', params: { url: signedMediaUrl(img.id, { jpeg: true }), published: 'false' } });
        ids.push(p.id);
      }
      const params: Record<string, string> = { message: input.message };
      ids.forEach((id, i) => (params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id })));
      const post = await graph(`/${sel.page_id}/feed`, { token, method: 'POST', params });
      return { id: String(post.id), url: `https://www.facebook.com/${post.id}` };
    }
    if (images[0]) {
      const p = await graph(`/${sel.page_id}/photos`, { token, method: 'POST', params: { url: signedMediaUrl(images[0].id, { jpeg: true }), caption: input.message } });
      return { id: String(p.post_id ?? p.id), url: `https://www.facebook.com/${p.post_id ?? p.id}` };
    }
    const post = await graph(`/${sel.page_id}/feed`, { token, method: 'POST', params: { message: input.message } });
    return { id: String(post.id), url: `https://www.facebook.com/${post.id}` };
  }

  // Instagram
  if (!sel.ig_user_id) throw new HttpError(412, 'The selected Page has no linked Instagram professional account.');
  const ig = sel.ig_user_id;
  let creationId: string;
  if (input.placement === 'story') {
    const m = video ?? images[0];
    if (!m) throw new HttpError(400, 'Instagram Stories need an image or video.');
    const c = await graph(`/${ig}/media`, {
      token, method: 'POST',
      params: m.kind === 'video' ? { media_type: 'STORIES', video_url: signedMediaUrl(m.id) } : { media_type: 'STORIES', image_url: signedMediaUrl(m.id, { jpeg: true }) },
    });
    creationId = c.id;
    if (m.kind === 'video') await waitForContainer(creationId, token);
  } else if (video) {
    const c = await graph(`/${ig}/media`, { token, method: 'POST', params: { media_type: 'REELS', video_url: signedMediaUrl(video.id), caption: input.message, share_to_feed: 'true' } });
    creationId = c.id;
    await waitForContainer(creationId, token);
  } else if (images.length > 1) {
    const children: string[] = [];
    for (const img of images.slice(0, 10)) {
      const c = await graph(`/${ig}/media`, { token, method: 'POST', params: { image_url: signedMediaUrl(img.id, { feed: true }), is_carousel_item: 'true' } });
      children.push(c.id);
    }
    const c = await graph(`/${ig}/media`, { token, method: 'POST', params: { media_type: 'CAROUSEL', children: children.join(','), caption: input.message } });
    creationId = c.id;
  } else if (images[0]) {
    const c = await graph(`/${ig}/media`, { token, method: 'POST', params: { image_url: signedMediaUrl(images[0].id, { feed: true }), caption: input.message } });
    creationId = c.id;
  } else {
    throw new HttpError(400, 'Instagram posts need an image or video.');
  }
  // Images are processed asynchronously too: publishing before the container is FINISHED fails
  // with "Media ID is not available" (code 9007). Wait for every container, then retry briefly.
  await waitForContainer(creationId, token);
  let pub: any;
  for (let attempt = 1; ; attempt++) {
    try {
      pub = await graph(`/${ig}/media_publish`, { token, method: 'POST', params: { creation_id: creationId } });
      break;
    } catch (e) {
      const d = (e as HttpError).details as any;
      if (attempt >= 4 || !(d?.code === 9007 || d?.subcode === 2207027)) throw e;
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
  const info = await graph(`/${pub.id}`, { token, params: { fields: 'permalink' } }).catch(() => ({}));
  return { id: String(pub.id), url: (info as any).permalink ?? null };
}

// ---------- Performance (read-only) ----------

export interface PostStats { id: string; text: string; at: string; url: string | null; image: string | null; views: number | null; likes: number; comments: number; shares: number | null }
export interface PlatformStats { available: boolean; account: string | null; followers: number | null; posts: PostStats[]; totals: { views: number | null; likes: number; comments: number; shares: number | null }; note: string | null }

const sum = (xs: (number | null)[]) => (xs.some((x) => x === null) && xs.every((x) => x === null) ? null : xs.reduce<number>((a, x) => a + (x ?? 0), 0));
const totals = (posts: PostStats[]) => ({ views: sum(posts.map((p) => p.views)), likes: posts.reduce((a, p) => a + p.likes, 0), comments: posts.reduce((a, p) => a + p.comments, 0), shares: sum(posts.map((p) => p.shares)) });

/** First insight metric the token can read, or null (views need read_insights / instagram_manage_insights). */
async function firstMetric(id: string, token: string, metrics: string[]): Promise<{ value: number | null; denied: boolean }> {
  let denied = false;
  for (const m of metrics) {
    try {
      const j = await graph(`/${id}/insights`, { token, params: { metric: m } });
      const v = j.data?.[0]?.values?.[0]?.value ?? j.data?.[0]?.total_value?.value;
      if (typeof v === 'number') return { value: v, denied: false };
    } catch (e) {
      const code = (e as HttpError).details as any;
      if (code?.code === 10 || code?.code === 200) denied = true;
    }
  }
  return { value: null, denied };
}

/** Followers and the last posts on the default Page and its Instagram account, with likes, comments and views. */
export async function metaPerformance(limit = 12): Promise<{ facebook: PlatformStats; instagram: PlatformStats }> {
  const none = (note: string): PlatformStats => ({ available: false, account: null, followers: null, posts: [], totals: { views: null, likes: 0, comments: 0, shares: null }, note });
  if (!metaTokenConfigured()) return { facebook: none('Facebook is not connected.'), instagram: none('Instagram is not connected.') };
  const page = (await metaPages(true)).find((p) => p.is_default);
  if (!page) return { facebook: none('No default Facebook Page.'), instagram: none('No default Facebook Page.') };
  const token = await pageToken(page.page_id);

  const fb = async (): Promise<PlatformStats> => {
    const info = await graph(`/${page.page_id}`, { token, params: { fields: 'name,followers_count,fan_count' } });
    const fields = 'id,message,created_time,permalink_url,full_picture,shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)';
    // The Page's own posts list needs pages_read_user_content; without it, read the posts this
    // dashboard published one by one (pages_read_engagement is enough for those).
    const j = await graph(`/${page.page_id}/published_posts`, { token, params: { fields, limit: String(limit) } }).catch(async () => {
      const { rows } = await query(
        `SELECT p.platform_post_id FROM publications p JOIN content_targets t ON t.id = p.target_id
          WHERE t.platform = 'facebook' AND p.platform_post_id IS NOT NULL ORDER BY p.published_at DESC LIMIT $1`,
        [limit],
      );
      const data = (await Promise.all(rows.map((r) => graph(`/${r.platform_post_id}`, { token, params: { fields } }).catch(() => null)))).filter(Boolean);
      return { data, fallback: true };
    });
    let denied = false;
    const posts: PostStats[] = await Promise.all((j.data ?? []).map(async (x: any) => {
      const v = await firstMetric(x.id, token, ['post_media_view', 'post_impressions']);
      denied ||= v.denied;
      return { id: x.id, text: x.message ?? '', at: x.created_time, url: x.permalink_url ?? null, image: x.full_picture ?? null, views: v.value, likes: x.reactions?.summary?.total_count ?? 0, comments: x.comments?.summary?.total_count ?? 0, shares: x.shares?.count ?? 0 };
    }));
    const notes = [
      (j as any).fallback && 'Showing posts made from this dashboard; posts made directly on Facebook need the pages_read_user_content permission.',
      denied && 'Views need the read_insights permission on the Meta token.',
    ].filter(Boolean);
    return { available: true, account: info.name, followers: info.followers_count ?? info.fan_count ?? null, posts, totals: totals(posts), note: notes.join(' ') || null };
  };

  const ig = async (): Promise<PlatformStats> => {
    if (!page.ig_user_id) return none('No Instagram account is linked to the default Page.');
    const info = await graph(`/${page.ig_user_id}`, { token, params: { fields: 'username,followers_count,media_count' } });
    const j = await graph(`/${page.ig_user_id}/media`, { token, params: { fields: 'id,caption,media_type,permalink,timestamp,like_count,comments_count,media_url,thumbnail_url', limit: String(limit) } });
    let denied = false;
    const posts: PostStats[] = await Promise.all((j.data ?? []).map(async (x: any) => {
      const v = await firstMetric(x.id, token, ['views', 'reach']);
      denied ||= v.denied;
      return { id: x.id, text: x.caption ?? '', at: x.timestamp, url: x.permalink ?? null, image: x.media_type === 'VIDEO' ? x.thumbnail_url ?? null : x.media_url ?? null, views: v.value, likes: x.like_count ?? 0, comments: x.comments_count ?? 0, shares: null };
    }));
    return { available: true, account: `@${info.username}`, followers: info.followers_count ?? null, posts, totals: totals(posts), note: denied ? 'Views need the instagram_manage_insights permission on the Meta token.' : null };
  };

  const [f, i] = await Promise.allSettled([fb(), ig()]);
  return {
    facebook: f.status === 'fulfilled' ? f.value : none((f.reason as Error).message),
    instagram: i.status === 'fulfilled' ? i.value : none((i.reason as Error).message),
  };
}