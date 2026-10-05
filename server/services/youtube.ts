import { query, tx } from '../db/pool.js';
import type { SessionUser } from '../../shared/domain.js';
import { PLAYLISTS } from '../../shared/domain.js';
import { googleAccessToken } from './googleOAuth.js';
import { audit } from './audit.js';
import { HttpError } from '../http.js';
import { brand } from '../brand.js';

const API = 'https://www.googleapis.com/youtube/v3';

async function yt(path: string, init: RequestInit = {}, channelId?: string) {
  const token = await googleAccessToken(channelId);
  const res = await fetch(path.startsWith('http') ? path : `${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const reason = json?.error?.errors?.[0]?.reason;
    const msg = json?.error?.message ?? `YouTube API HTTP ${res.status}`;
    throw new HttpError(res.status === 403 && reason === 'quotaExceeded' ? 429 : 502, reason === 'quotaExceeded' ? 'YouTube daily API quota is used up. It resets at midnight Pacific time.' : `YouTube: ${msg}`);
  }
  return json;
}

export async function channelSummary(channelId?: string) {
  const j = await yt('/channels?part=snippet,statistics,contentDetails&mine=true', {}, channelId);
  const c = j.items?.[0];
  if (!c) throw new HttpError(404, 'No channel found for the connected Google account.');
  return {
    id: c.id as string,
    title: c.snippet.title as string,
    subscribers: Number(c.statistics?.subscriberCount ?? 0),
    videos: Number(c.statistics?.videoCount ?? 0),
    views: Number(c.statistics?.viewCount ?? 0),
    uploadsPlaylist: c.contentDetails.relatedPlaylists.uploads as string,
  };
}

function isoDurationSeconds(d?: string) {
  const m = d?.match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return null;
  return (+(m[1] ?? 0)) * 86400 + (+(m[2] ?? 0)) * 3600 + (+(m[3] ?? 0)) * 60 + +(m[4] ?? 0);
}

function statusFrom(v: any): { youtube_status: string; privacy: string; publishAt: string | null } {
  const privacy = v.status.privacyStatus as string;
  const publishAt = v.status.publishAt ?? null;
  if (privacy === 'public') return { youtube_status: 'public', privacy, publishAt };
  if (privacy === 'private' && publishAt) return { youtube_status: 'scheduled', privacy, publishAt };
  return { youtube_status: 'uploaded_private', privacy, publishAt };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Pull every upload on the channel into the library: link existing library videos by
 * YouTube id or title, create entries for the rest, and refresh status, views and URLs.
 */
export async function syncChannel(user: SessionUser | null) {
  const { rows: run } = await query(`INSERT INTO workflow_runs (kind, summary, triggered_by) VALUES ('youtube_sync', 'Sync YouTube channel', $1) RETURNING id`, [user?.id ?? null]);
  try {
    const ch = await channelSummary();
    const ids: string[] = [];
    let page: string | undefined;
    do {
      const j = await yt(`/playlistItems?part=contentDetails&maxResults=50&playlistId=${ch.uploadsPlaylist}${page ? `&pageToken=${page}` : ''}`);
      ids.push(...j.items.map((i: any) => i.contentDetails.videoId));
      page = j.nextPageToken;
    } while (page && ids.length < 1000);

    let linked = 0;
    let created = 0;
    let updated = 0;
    const library = (await query('SELECT id, title, public_title, youtube_video_id FROM videos WHERE archived_at IS NULL')).rows;
    for (let i = 0; i < ids.length; i += 50) {
      const j = await yt(`/videos?part=snippet,status,statistics,contentDetails&id=${ids.slice(i, i + 50).join(',')}`);
      for (const v of j.items) {
        const s = statusFrom(v);
        const fields = [
          v.id, `https://youtu.be/${v.id}`, s.youtube_status, s.privacy, s.publishAt, v.snippet.title,
          Number(v.statistics?.viewCount ?? 0), isoDurationSeconds(v.contentDetails?.duration),
          v.snippet.thumbnails?.high?.url ?? v.snippet.thumbnails?.default?.url ?? null,
        ];
        const byId = library.find((l) => l.youtube_video_id === v.id);
        const byTitle = !byId && library.find((l) => !l.youtube_video_id && [l.title, l.public_title].filter(Boolean).some((t: string) => norm(t) === norm(v.snippet.title) || norm(v.snippet.title).includes(norm(t))));
        const target = byId ?? byTitle;
        if (target) {
          await query(
            `UPDATE videos SET youtube_video_id = $2, youtube_url = $3, youtube_status = $4, youtube_privacy = $5, youtube_publish_at = $6,
               youtube_title = $7, youtube_views = $8, duration_seconds = COALESCE(duration_seconds, $9), thumbnail_url = COALESCE(thumbnail_url, $10),
               public_title = COALESCE(public_title, $7), description = COALESCE(description, $11), youtube_synced_at = now(), updated_at = now()
             WHERE id = $1`,
            [target.id, ...fields, v.snippet.description || null],
          );
          if (byId) updated++;
          else {
            linked++;
            target.youtube_video_id = v.id;
          }
        } else {
          await query(
            `INSERT INTO videos (source_key, title, public_title, description, youtube_video_id, youtube_url, youtube_status, youtube_privacy,
               youtube_publish_at, youtube_title, youtube_views, duration_seconds, thumbnail_url, youtube_synced_at, campaign_id)
             VALUES ($1, $7, $7, $11, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), (SELECT id FROM campaigns WHERE slug = '${brand.libraryCampaignSlug}'))
             ON CONFLICT (youtube_video_id) DO NOTHING`,
            [`youtube:${v.id}`, ...fields, v.snippet.description || null],
          );
          created++;
        }
      }
    }
    const playlists = await syncPlaylists();
    const summary = { channel: ch.title, channel_videos: ids.length, updated, linked, created, playlists };
    await query(`UPDATE workflow_runs SET status = 'succeeded', finished_at = now(), response = $2 WHERE id = $1`, [run[0].id, JSON.stringify(summary)]);
    await query(`UPDATE connections SET status = 'connected', last_success_at = now(), last_checked_at = now(), last_error = NULL WHERE key = 'youtube'`);
    await audit({ actor: user, action: 'youtube.sync', entityType: 'connection', entityId: 'youtube', next: summary, result: 'success', executionId: run[0].id });
    return summary;
  } catch (e) {
    const msg = (e as Error).message;
    await query(`UPDATE workflow_runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`, [run[0].id, msg]);
    await query(`UPDATE connections SET last_error = $1, last_error_at = now(), last_checked_at = now() WHERE key = 'youtube'`, [msg]);
    await audit({ actor: user, action: 'youtube.sync', entityType: 'connection', entityId: 'youtube', result: 'failure', detail: msg, executionId: run[0].id });
    throw e;
  }
}

async function syncPlaylists() {
  let page: string | undefined;
  let n = 0;
  do {
    const j = await yt(`/playlists?part=snippet&mine=true&maxResults=50${page ? `&pageToken=${page}` : ''}`);
    for (const p of j.items) {
      await query(`INSERT INTO youtube_playlists (name, youtube_playlist_id) VALUES ($1, $2)
        ON CONFLICT (name) DO UPDATE SET youtube_playlist_id = EXCLUDED.youtube_playlist_id`, [p.snippet.title, p.id]);
      n++;
    }
    page = j.nextPageToken;
  } while (page);
  return n;
}

/** Create any of the six standard playlists that do not exist on the channel yet. */
export async function ensurePlaylists(user: SessionUser) {
  await syncPlaylists();
  const have = new Set((await query('SELECT name FROM youtube_playlists')).rows.map((r) => r.name));
  const created: string[] = [];
  for (const name of PLAYLISTS) {
    if (have.has(name)) continue;
    const p = await yt('/playlists?part=snippet,status', {
      method: 'POST',
      body: JSON.stringify({ snippet: { title: name, description: `NFAMation · ${name}. General educational information only; not legal advice.` }, status: { privacyStatus: 'public' } }),
    });
    await query('INSERT INTO youtube_playlists (name, youtube_playlist_id) VALUES ($1, $2)', [name, p.id]);
    created.push(name);
  }
  await audit({ actor: user, action: 'youtube.playlists.ensure', entityType: 'connection', entityId: 'youtube', next: { created }, result: 'success' });
  return { created, existing: PLAYLISTS.length - created.length };
}

async function addToPlaylist(videoId: string, youtubeVideoId: string, playlist: string) {
  const pl = (await query('SELECT youtube_playlist_id FROM youtube_playlists WHERE name = $1', [playlist])).rows[0];
  if (!pl) return { added: false, reason: `Playlist "${playlist}" does not exist on the channel yet. Use "Create playlists" first.` };
  const done = await query('SELECT 1 FROM youtube_playlist_items WHERE video_id = $1 AND youtube_playlist_id = $2', [videoId, pl.youtube_playlist_id]);
  if (done.rowCount) return { added: false, reason: 'Already in playlist' };
  const item = await yt('/playlistItems?part=snippet', {
    method: 'POST',
    body: JSON.stringify({ snippet: { playlistId: pl.youtube_playlist_id, resourceId: { kind: 'youtube#video', videoId: youtubeVideoId } } }),
  });
  await query('INSERT INTO youtube_playlist_items (video_id, youtube_playlist_id, playlist_item_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [videoId, pl.youtube_playlist_id, item.id]);
  return { added: true };
}

function statusBody(v: any, visibility: 'private' | 'unlisted' | 'public' | 'scheduled') {
  if (visibility === 'scheduled') {
    if (!v.release_at || new Date(v.release_at).getTime() < Date.now() + 15 * 60_000) {
      throw new HttpError(400, 'Scheduling needs a release date at least 15 minutes in the future.');
    }
    return { privacyStatus: 'private', publishAt: new Date(v.release_at).toISOString(), selfDeclaredMadeForKids: false };
  }
  return { privacyStatus: visibility, selfDeclaredMadeForKids: false };
}

/**
 * Push the dashboard's title, description, visibility and playlist to an existing YouTube video.
 * Never deletes anything on YouTube.
 */
export async function pushVideo(videoId: string, visibility: 'private' | 'unlisted' | 'public' | 'scheduled', user: SessionUser) {
  const v = (await query('SELECT * FROM videos WHERE id = $1', [videoId])).rows[0];
  if (!v) throw new HttpError(404, 'Video not found.');
  if (!v.youtube_video_id) throw new HttpError(409, 'This video is not on YouTube yet. Upload it first.');
  const title = (v.public_title || v.title).trim();
  if (title.length > 100) throw new HttpError(400, 'YouTube titles are limited to 100 characters.');
  if (/[<>]/.test(title)) throw new HttpError(400, 'YouTube titles cannot contain < or >.');
  const current = await yt(`/videos?part=snippet,status&id=${v.youtube_video_id}`);
  const cur = current.items?.[0];
  if (!cur) throw new HttpError(404, 'The video no longer exists on YouTube (it may have been deleted in Studio).');
  const { rows: run } = await query(`INSERT INTO workflow_runs (kind, summary, triggered_by, request) VALUES ('youtube_update', $1, $2, $3) RETURNING id`, [
    `Update ${v.ref} on YouTube`, user.id, JSON.stringify({ title, visibility }),
  ]);
  try {
    const body = {
      id: v.youtube_video_id,
      snippet: { title, description: v.description ?? cur.snippet.description ?? '', categoryId: cur.snippet.categoryId, tags: cur.snippet.tags, defaultLanguage: cur.snippet.defaultLanguage },
      status: statusBody(v, visibility),
    };
    const upd = await yt('/videos?part=snippet,status', { method: 'PUT', body: JSON.stringify(body) });
    const s = statusFrom(upd);
    await query(
      `UPDATE videos SET youtube_status = $2, youtube_privacy = $3, youtube_publish_at = $4, youtube_title = $5, youtube_synced_at = now(), updated_at = now() WHERE id = $1`,
      [videoId, s.youtube_status, s.privacy, s.publishAt, upd.snippet.title],
    );
    const playlist = v.playlist ? await addToPlaylist(videoId, v.youtube_video_id, v.playlist) : { added: false, reason: 'No playlist chosen' };
    const result = { youtube_status: s.youtube_status, privacy: s.privacy, publish_at: s.publishAt, playlist };
    await query(`UPDATE workflow_runs SET status = 'succeeded', finished_at = now(), response = $2, execution_id = $3 WHERE id = $1`, [run[0].id, JSON.stringify(result), v.youtube_video_id]);
    await audit({ actor: user, action: 'youtube.update', entityType: 'video', entityId: videoId, previous: { title: cur.snippet.title, privacy: cur.status.privacyStatus, publish_at: cur.status.publishAt ?? null }, next: { title, ...result }, executionId: v.youtube_video_id, result: 'success' });
    return result;
  } catch (e) {
    await query(`UPDATE workflow_runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`, [run[0].id, (e as Error).message]);
    await audit({ actor: user, action: 'youtube.update', entityType: 'video', entityId: videoId, result: 'failure', detail: (e as Error).message });
    throw e;
  }
}

const EXT_MIME: Record<string, string> = { mov: 'video/quicktime', mp4: 'video/mp4', m4v: 'video/x-m4v', webm: 'video/webm', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };

/**
 * Open a Drive file as a stream. Files in a folder shared "anyone with the link" download without
 * credentials; otherwise the Drive API is used via the service account, if configured.
 */
export async function openDriveFile(fileId: string) {
  const pub = await fetch(`https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`, { redirect: 'follow' });
  const type = pub.headers.get('content-type') ?? '';
  if (pub.ok && pub.body && !type.startsWith('text/html')) {
    const name = /filename\*?=(?:UTF-8'')?"?([^";]+)/i.exec(pub.headers.get('content-disposition') ?? '')?.[1] ?? fileId;
    const ext = decodeURIComponent(name).split('.').pop()?.toLowerCase() ?? '';
    const mime = type && type !== 'application/octet-stream' ? type : EXT_MIME[ext] ?? 'application/octet-stream';
    return { body: pub.body, size: pub.headers.get('content-length'), mime, name: decodeURIComponent(name) };
  }
  await pub.body?.cancel().catch(() => {});
  const { serviceAccount } = await import('./google.js');
  if (!serviceAccount()) {
    throw new HttpError(412, 'Could not download the file from Drive. Make sure the NFAMation folder is shared "Anyone with the link" (Viewer), or configure a Google service account.');
  }
  const { driveApiToken } = await import('./google.js');
  const token = await driveApiToken();
  const meta: any = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,mimeType,size&supportsAllDrives=true`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());
  const media = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`, { headers: { authorization: `Bearer ${token}` } });
  if (!media.ok || !media.body) throw new HttpError(502, `Could not read the file from Drive (HTTP ${media.status}).`);
  return { body: media.body, size: meta.size ?? media.headers.get('content-length'), mime: meta.mimeType, name: meta.name };
}

/** Stream a Drive file straight into a YouTube resumable upload. Returns the new YouTube video. */
export async function uploadDriveFile(driveFileId: string, snippet: Record<string, unknown>, status: Record<string, unknown>) {
  const token = await googleAccessToken();
  const file = await openDriveFile(driveFileId);
  if (!file.mime.startsWith('video/')) {
    await file.body.cancel().catch(() => {});
    throw new HttpError(400, `The Drive file "${file.name}" is not a video (${file.mime}).`);
  }
  if (!file.size) {
    await file.body.cancel().catch(() => {});
    throw new HttpError(502, 'Drive did not report the file size, so the upload cannot start. Try again shortly.');
  }
  const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=UTF-8',
      'x-upload-content-length': file.size,
      'x-upload-content-type': file.mime,
    },
    body: JSON.stringify({ snippet, status }),
  });
  if (!init.ok) {
    await file.body.cancel().catch(() => {});
    const j: any = await init.json().catch(() => ({}));
    throw new HttpError(502, `YouTube rejected the upload: ${j?.error?.message ?? init.status}`);
  }
  const location = init.headers.get('location')!;
  const media = file;
  const meta = { size: file.size, mimeType: file.mime };
  const put = await fetch(location, {
    method: 'PUT',
    headers: { 'content-length': meta.size, 'content-type': meta.mimeType },
    body: media.body as any,
    // Required by Node's fetch for streaming request bodies.
    duplex: 'half',
  } as RequestInit);
  const j: any = await put.json().catch(() => ({}));
  if (!put.ok) throw new HttpError(502, `YouTube upload failed: ${j?.error?.message ?? put.status}`);
  return j;
}

async function setThumbnail(youtubeVideoId: string, thumbnailUrl: string) {
  const id = thumbnailUrl.match(/\/d\/([\w-]{10,})/)?.[1] ?? thumbnailUrl.match(/[?&]id=([\w-]{10,})/)?.[1];
  if (!id) return 'Thumbnail link is not a Drive file; set it in YouTube Studio.';
  const token = await googleAccessToken();
  const img = await openDriveFile(id);
  const buf = Buffer.from(await new Response(img.body).arrayBuffer());
  if (buf.length > 2 * 1024 * 1024) return 'Thumbnail is larger than YouTube\'s 2 MB limit; set it in YouTube Studio.';
  const res = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${youtubeVideoId}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': img.mime.startsWith('image/') ? img.mime : 'image/jpeg' },
    body: buf,
  });
  if (!res.ok) {
    const j: any = await res.json().catch(() => ({}));
    return `Thumbnail not set: ${j?.error?.message ?? res.status} (custom thumbnails need a verified channel).`;
  }
  return 'Thumbnail set';
}

/**
 * Upload a library video from Drive. Runs in the background; the run row tracks progress.
 * Guarded so the same video can never be uploaded twice.
 */
export async function startUpload(videoId: string, visibility: 'private' | 'unlisted' | 'scheduled', user: SessionUser) {
  const claim = await tx(async (client) => {
    const { rows } = await client.query('SELECT * FROM videos WHERE id = $1 FOR UPDATE', [videoId]);
    const v = rows[0];
    if (!v) throw new HttpError(404, 'Video not found.');
    if (v.youtube_video_id) throw new HttpError(409, 'This video is already on YouTube. Duplicate uploads are blocked.');
    if (v.youtube_upload_status === 'uploading') throw new HttpError(409, 'An upload for this video is already running.');
    if (!v.drive_file_id) throw new HttpError(412, 'Add the final video (Drive link) first.');
    const title = (v.public_title || v.title).trim();
    if (!v.public_title) throw new HttpError(412, 'Add a search-friendly public title first.');
    if (title.length > 100) throw new HttpError(400, 'YouTube titles are limited to 100 characters.');
    if (!v.description) throw new HttpError(412, 'Add a description first.');
    const status = statusBody(v, visibility);
    await client.query(`UPDATE videos SET youtube_upload_status = 'uploading', updated_at = now() WHERE id = $1`, [videoId]);
    return { v, title, status };
  });
  const { rows: run } = await query(`INSERT INTO workflow_runs (kind, summary, triggered_by, request) VALUES ('youtube_upload', $1, $2, $3) RETURNING id`, [
    `Upload ${claim.v.ref} to YouTube`, user.id, JSON.stringify({ title: claim.title, visibility, drive_file_id: claim.v.drive_file_id }),
  ]);
  await audit({ actor: user, action: 'youtube.upload.start', entityType: 'video', entityId: videoId, next: { title: claim.title, visibility }, executionId: run[0].id, result: 'success' });

  void (async () => {
    try {
      const yv = await uploadDriveFile(
        claim.v.drive_file_id,
        { title: claim.title, description: claim.v.description, categoryId: '27' },
        claim.status,
      );
      const s = statusFrom(yv);
      await query(
        `UPDATE videos SET youtube_video_id = $2, youtube_url = $3, youtube_status = $4, youtube_privacy = $5, youtube_publish_at = $6,
           youtube_title = $7, youtube_upload_status = 'done', youtube_synced_at = now(), updated_at = now() WHERE id = $1`,
        [videoId, yv.id, `https://youtu.be/${yv.id}`, s.youtube_status, s.privacy, s.publishAt, yv.snippet?.title ?? claim.title],
      );
      const thumb = claim.v.thumbnail_url ? await setThumbnail(yv.id, claim.v.thumbnail_url).catch((e) => String(e.message)) : 'No thumbnail';
      const playlist = claim.v.playlist ? await addToPlaylist(videoId, yv.id, claim.v.playlist).catch((e) => ({ added: false, reason: (e as Error).message })) : { added: false, reason: 'No playlist chosen' };
      const result = { youtube_video_id: yv.id, url: `https://youtu.be/${yv.id}`, status: s, thumbnail: thumb, playlist };
      await query(`UPDATE workflow_runs SET status = 'succeeded', finished_at = now(), execution_id = $2, response = $3 WHERE id = $1`, [run[0].id, yv.id, JSON.stringify(result)]);
      await audit({ actor: user, action: 'youtube.upload.done', entityType: 'video', entityId: videoId, next: result, executionId: yv.id, result: 'success' });
    } catch (e) {
      const msg = (e as Error).message;
      await query(`UPDATE videos SET youtube_upload_status = 'failed', updated_at = now() WHERE id = $1`, [videoId]);
      await query(`UPDATE workflow_runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`, [run[0].id, msg]);
      await audit({ actor: user, action: 'youtube.upload.failed', entityType: 'video', entityId: videoId, result: 'failure', detail: msg, executionId: run[0].id });
    }
  })();
  return { run_id: run[0].id };
}

/** Subscribers and the latest uploads with views, likes and comments (read-only). */
export async function youtubePerformance(limit = 12, channelId?: string) {
  const ch = await channelSummary(channelId);
  const list = await yt(`/playlistItems?part=contentDetails&maxResults=${limit}&playlistId=${ch.uploadsPlaylist}`, {}, channelId);
  const ids = (list.items ?? []).map((i: any) => i.contentDetails.videoId).join(',');
  const vids = ids ? await yt(`/videos?part=snippet,statistics,status&id=${ids}`, {}, channelId) : { items: [] };
  const posts = (vids.items ?? []).map((v: any) => ({
    id: v.id as string,
    text: v.snippet.title as string,
    at: v.snippet.publishedAt as string,
    url: `https://www.youtube.com/watch?v=${v.id}`,
    image: v.snippet.thumbnails?.medium?.url ?? null,
    views: Number(v.statistics?.viewCount ?? 0),
    likes: Number(v.statistics?.likeCount ?? 0),
    comments: Number(v.statistics?.commentCount ?? 0),
    shares: null,
    privacy: v.status?.privacyStatus as string,
  }));
  return {
    available: true,
    account: ch.title,
    followers: ch.subscribers,
    posts,
    totals: { views: ch.views, likes: posts.reduce((a: number, p: any) => a + p.likes, 0), comments: posts.reduce((a: number, p: any) => a + p.comments, 0), shares: null },
    note: null,
  };
}