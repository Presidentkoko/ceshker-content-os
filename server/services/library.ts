import { query, tx } from '../db/pool.js';
import { config } from '../config.js';
import type { SessionUser } from '../../shared/domain.js';
import { audit, diff } from './audit.js';
import { listDriveTree } from './google.js';
import { configurationBlocker, refreshGoogleLinked } from './connections.js';
import { createContent } from './content.js';
import { HttpError } from '../http.js';
import { brand, driveFolderId } from '../brand.js';

export const DERIVATIVES = [
  { kind: 'reel', label: 'Primary Reel / Short (30–90s)', content_type: 'reel', placements: [['facebook', 'reel'], ['instagram', 'reel'], ['youtube', 'short']] },
  { kind: 'micro', label: 'Micro-clip (10–20s)', content_type: 'short', placements: [['facebook', 'story'], ['instagram', 'story']] },
  { kind: 'carousel', label: 'Text post / carousel', content_type: 'carousel', placements: [['facebook', 'feed'], ['instagram', 'feed'], ['linkedin', 'post']] },
] as const;

export function videoReadiness(v: any) {
  const missing: string[] = [];
  if (!v.drive_file_id && !v.drive_url) missing.push('Final video file');
  if (!v.public_title) missing.push('Search-friendly public title');
  if (!v.description) missing.push('Description');
  if (!v.playlist) missing.push('Playlist');
  if (!v.thumbnail_url) missing.push('Thumbnail');
  if (!v.release_at) missing.push('Release date');
  if (v.public_title && v.public_title.length > 100) missing.push('Title under 100 characters');
  return { youtube_ready: missing.length === 0, missing };
}

const VIDEO_SELECT = `
  SELECT v.*, cp.name AS campaign_name,
    (SELECT count(*) FROM content_items c WHERE c.video_id = v.id AND c.archived_at IS NULL) AS derivative_count,
    (SELECT COALESCE(json_agg(json_build_object('id', c.id, 'ref', c.ref, 'title', c.title, 'content_type', c.content_type,
        'approval_status', c.approval_status, 'publish_status', c.publish_status, 'scheduled_at', c.scheduled_at) ORDER BY c.scheduled_at NULLS LAST), '[]')
      FROM content_items c WHERE c.video_id = v.id AND c.archived_at IS NULL) AS derivatives
  FROM videos v LEFT JOIN campaigns cp ON cp.id = v.campaign_id`;

export async function listVideos(f: { q?: string; playlist?: string; youtube_status?: string; archived?: boolean }) {
  const where: string[] = [f.archived ? 'v.archived_at IS NOT NULL' : 'v.archived_at IS NULL'];
  const params: unknown[] = [];
  if (f.q) {
    params.push(`%${f.q}%`);
    where.push(`(v.title ILIKE $${params.length} OR v.public_title ILIKE $${params.length} OR v.ref ILIKE $${params.length} OR v.description ILIKE $${params.length})`);
  }
  if (f.playlist) {
    params.push(f.playlist);
    where.push(`v.playlist = $${params.length}`);
  }
  if (f.youtube_status) {
    params.push(f.youtube_status);
    where.push(`v.youtube_status = $${params.length}`);
  }
  const { rows } = await query(`${VIDEO_SELECT} WHERE ${where.join(' AND ')} ORDER BY v.series_no NULLS LAST, v.created_at`, params);
  return rows.map((v) => ({ ...v, ...videoReadiness(v) }));
}

export async function getVideo(id: string) {
  const { rows } = await query(`${VIDEO_SELECT} WHERE v.id = $1`, [id]);
  if (!rows[0]) throw new HttpError(404, 'Video not found.');
  const activity = await query(`SELECT * FROM audit_log WHERE entity_type = 'video' AND entity_id = $1 ORDER BY created_at DESC LIMIT 50`, [id]);
  const assets = await query('SELECT id, content_id, video_id, kind, url, drive_file_id, label, approved, created_by, created_at, mime, size_bytes, (data IS NOT NULL) AS stored FROM assets WHERE video_id = $1 ORDER BY created_at', [id]);
  return { ...rows[0], ...videoReadiness(rows[0]), activity: activity.rows, assets: assets.rows };
}

const VIDEO_FIELDS = ['title', 'public_title', 'description', 'series_no', 'playlist', 'drive_url', 'thumbnail_url', 'release_at', 'campaign_id', 'notes', 'youtube_status', 'youtube_url'] as const;

export async function createVideo(input: Record<string, any>, user: SessionUser) {
  const { rows } = await query(
    `INSERT INTO videos (title, public_title, description, series_no, playlist, drive_url, drive_file_id, thumbnail_url, release_at, campaign_id, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [input.title, input.public_title ?? null, input.description ?? null, input.series_no ?? null, input.playlist ?? null, input.drive_url ?? null,
      input.drive_url?.match(/\/d\/([\w-]{10,})/)?.[1] ?? null, input.thumbnail_url ?? null, input.release_at ?? null, input.campaign_id ?? null, input.notes ?? null],
  );
  await audit({ actor: user, action: 'video.create', entityType: 'video', entityId: rows[0].id, next: input, result: 'success' });
  return getVideo(rows[0].id);
}

export async function updateVideo(id: string, input: Record<string, any>, user: SessionUser) {
  return tx(async (client) => {
    const { rows } = await client.query('SELECT * FROM videos WHERE id = $1 FOR UPDATE', [id]);
    const before = rows[0];
    if (!before) throw new HttpError(404, 'Video not found.');
    const patch: Record<string, unknown> = {};
    for (const k of VIDEO_FIELDS) if (k in input) patch[k] = input[k] ?? null;
    const status = (patch.youtube_status ?? before.youtube_status) as string;
    const url = (patch.youtube_url !== undefined ? patch.youtube_url : before.youtube_url) as string | null;
    if (status !== 'not_uploaded' && !url) throw new HttpError(400, 'Add the YouTube URL when marking a video as uploaded, scheduled or public.');
    if (url && !/^https:\/\/(www\.)?(youtube\.com|youtu\.be)\//.test(url)) throw new HttpError(400, 'YouTube URL must start with https://youtube.com or https://youtu.be.');
    const { prev, next, changed } = diff(before, patch);
    if (!changed) return getVideo(id);
    if ('youtube_url' in next) {
      const vid = url?.match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/)?.[1] ?? null;
      next.youtube_video_id = vid;
    }
    if ('drive_url' in next) next.drive_file_id = (next.drive_url as string | null)?.match(/\/d\/([\w-]{10,})/)?.[1] ?? null;
    const keys = Object.keys(next);
    await client.query(`UPDATE videos SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`, [id, ...keys.map((k) => next[k])]);
    await audit({ actor: user, action: 'video.update', entityType: 'video', entityId: id, previous: prev, next, result: 'success' }, client);
    return null;
  }).then((r) => r ?? getVideo(id));
}

export async function setVideoArchived(id: string, archived: boolean, user: SessionUser) {
  const { rows } = await query(`UPDATE videos SET archived_at = ${archived ? 'now()' : 'NULL'}, updated_at = now() WHERE id = $1 RETURNING id`, [id]);
  if (!rows[0]) throw new HttpError(404, 'Video not found.');
  await audit({ actor: user, action: archived ? 'video.archive' : 'video.restore', entityType: 'video', entityId: id, result: 'success' });
}

/** Create a draft social derivative (Reel, micro-clip or carousel) linked to a library video. */
export async function createDerivative(videoId: string, kind: string, user: SessionUser) {
  const d = DERIVATIVES.find((x) => x.kind === kind);
  if (!d) throw new HttpError(400, 'Unknown derivative type.');
  const v = await getVideo(videoId);
  const exists = (v.derivatives as any[]).some((c) => c.content_type === d.content_type);
  if (exists) throw new HttpError(409, `A ${d.label} already exists for this video.`);
  const item = await createContent(
    {
      title: `${v.public_title || v.title} — ${d.label.split(' (')[0]}`,
      caption: null,
      description: v.description,
      category: brand.categories[0],
      content_type: d.content_type,
      campaign_id: v.campaign_id,
      video_id: v.id,
      timezone: config.APP_TIMEZONE,
      notes: `Derived from ${v.ref}. Recut in 9:16 with burned-in captions and a strong opening line.`,
      targets: d.placements.map(([platform, placement]) => ({ platform: platform as any, placement })),
    },
    user,
  );
  await audit({ actor: user, action: 'video.derivative', entityType: 'video', entityId: videoId, next: { content_ref: item.ref, kind }, result: 'success' });
  return item;
}

const normTitle = (s: string) =>
  s.toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/\bfinal\b/g, ' ')
    .replace(/\blein\b/g, 'lien')
    .replace(/\bdue on sale\b/g, 'dos')
    .replace(/\bdealing (a|with a|with)\b/g, 'dealing')
    .replace(/\bdocuments?\b/g, 'document')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Import from a folder shared "anyone with the link" (no credentials). One library video per
 * topic: a topic folder's own video wins over copies nested inside other topic folders.
 */
export async function syncPublicDrive(user: SessionUser | null) {
  const root = driveFolderId();
  if (!root) throw new HttpError(412, 'Needs DRIVE_FOLDER_ID.');
  const { rows: run } = await query(`INSERT INTO workflow_runs (kind, summary, triggered_by) VALUES ('sheet_sync', $2, $1) RETURNING id`, [user?.id ?? null, `Import ${brand.videoBrand} videos from shared Drive folder`]);
  try {
    const { listPublicTree } = await import('./drivePublic.js');
    let tree = await listPublicTree(root, 1);
    const finalFolder = tree.find((e) => e.kind === 'folder' && e.path === '' && /final/i.test(e.name) && /youtube/i.test(e.name));
    const base = finalFolder ? finalFolder.id : root;
    tree = await listPublicTree(base, 3);

    const topics = new Map<string, { title: string; file: (typeof tree)[number]; thumb?: (typeof tree)[number]; depth: number; series: number | null }>();
    for (const f of tree.filter((e) => e.kind === 'video')) {
      const parts = f.path.split('/').filter(Boolean);
      const fileTitle = f.name.replace(/\.\w+$/, '');
      const series = Number(fileTitle.match(/^(\d{1,3})\.\s/)?.[1] ?? NaN);
      const title = (parts.length ? parts[parts.length - 1] : fileTitle.replace(/^\d{1,3}\.\s*/, '')).replace(/\s*\((?:with )?intro.*$/i, '').trim();
      const key = normTitle(title);
      const prev = topics.get(key);
      if (prev && prev.depth <= parts.length) continue;
      const thumb = tree.find((i) => i.kind === 'image' && i.path === f.path && f.path !== '');
      topics.set(key, { title, file: f, thumb, depth: parts.length, series: Number.isFinite(series) ? series : null });
    }

    const library = (await query('SELECT id, title, public_title, drive_file_id, series_no FROM videos WHERE archived_at IS NULL')).rows;
    let created = 0;
    let linked = 0;
    let unchanged = 0;
    for (const [key, t] of topics) {
      if (library.some((l) => l.drive_file_id === t.file.id)) {
        unchanged++;
        continue;
      }
      const sameTopic = (x: string) => {
        const n = normTitle(x);
        if (n === key) return true;
        // Containment only for longer titles, so "MOC" never swallows "Releasing MOC".
        const [short, long] = n.length < key.length ? [n, key] : [key, n];
        return short.length >= 10 && long.includes(short);
      };
      const match =
        library.find((l) => !l.drive_file_id && [l.title, l.public_title].filter(Boolean).some((x: string) => normTitle(x) === key)) ??
        library.find((l) => !l.drive_file_id && [l.title, l.public_title].filter(Boolean).some(sameTopic));
      if (match) {
        await query(
          `UPDATE videos SET drive_file_id = $2, drive_url = $3, thumbnail_url = COALESCE(thumbnail_url, $4), updated_at = now() WHERE id = $1`,
          [match.id, t.file.id, t.file.url, t.thumb?.url ?? null],
        );
        match.drive_file_id = t.file.id;
        linked++;
      } else {
        await query(
          `INSERT INTO videos (source_key, title, series_no, drive_file_id, drive_url, thumbnail_url, campaign_id)
           VALUES ($1, $2, $3, $4, $5, $6, (SELECT id FROM campaigns WHERE slug = $7))
           ON CONFLICT (source_key) DO NOTHING`,
          [`drive:${t.file.id}`, t.title, t.series, t.file.id, t.file.url, t.thumb?.url ?? null, brand.libraryCampaignSlug],
        );
        created++;
      }
    }
    const summary = { folder: finalFolder?.name ?? 'root', video_files: tree.filter((e) => e.kind === 'video').length, topics: topics.size, created, linked, unchanged };
    await query(`UPDATE connections SET status='connected', last_success_at=now(), last_checked_at=now(), last_error=NULL WHERE key='google_drive'`);
    await query(`UPDATE workflow_runs SET status='succeeded', finished_at=now(), response=$2 WHERE id=$1`, [run[0].id, JSON.stringify(summary)]);
    await audit({ actor: user, action: 'drive.sync', entityType: 'video', entityId: root, next: summary, result: 'success', executionId: run[0].id });
    return summary;
  } catch (e) {
    const msg = (e as Error).message;
    await query(`UPDATE workflow_runs SET status='failed', finished_at=now(), error=$2 WHERE id=$1`, [run[0].id, msg]);
    await query(`UPDATE connections SET status='disconnected', last_error=$1, last_error_at=now(), last_checked_at=now() WHERE key='google_drive'`, [msg]);
    await audit({ actor: user, action: 'drive.sync', entityType: 'video', result: 'failure', detail: msg, executionId: run[0].id });
    throw new HttpError(502, `Drive import failed: ${msg}`);
  }
}

/** Import final videos (and sibling thumbnails) from the NFAMation Drive folder. */
export async function syncDrive(user: SessionUser) {
  await refreshGoogleLinked();
  const blocker = configurationBlocker('google_drive');
  // Prefer the folder's link share (topic-aware, restricted to "Final / For YouTube");
  // use the Drive API only when the folder is private.
  try {
    return await syncPublicDrive(user);
  } catch (e) {
    if (blocker) throw e;
  }
  const { rows: run } = await query(`INSERT INTO workflow_runs (kind, summary, triggered_by) VALUES ('sheet_sync', $2, $1) RETURNING id`, [user.id, `Import ${brand.videoBrand} videos from Drive`]);
  try {
    const files = await listDriveTree(driveFolderId()!);
    const videos = files.filter((f) => f.mimeType.startsWith('video/'));
    const images = files.filter((f) => f.mimeType.startsWith('image/'));
    let created = 0;
    let linked = 0;
    let unchanged = 0;
    for (const f of videos) {
      const thumb = images.find((i) => i.path === f.path && f.path !== '') ?? images.find((i) => i.name.replace(/\.\w+$/, '') === f.name.replace(/\.\w+$/, ''));
      const title = f.name.replace(/\.\w+$/, '').replace(/[_]+/g, ' ').trim();
      const series = Number(title.match(/(?:^|#|\b)(\d{1,3})\b/)?.[1] ?? NaN);
      const duration = f.videoMediaMetadata?.durationMillis ? Math.round(Number(f.videoMediaMetadata.durationMillis) / 1000) : null;
      const existing = await query('SELECT id FROM videos WHERE drive_file_id = $1', [f.id]);
      if (existing.rowCount) {
        await query('UPDATE videos SET duration_seconds = COALESCE($2, duration_seconds), thumbnail_url = COALESCE(thumbnail_url, $3) WHERE id = $1', [existing.rows[0].id, duration, thumb?.webViewLink ?? null]);
        unchanged++;
        continue;
      }
      const match = Number.isFinite(series)
        ? await query('SELECT id FROM videos WHERE series_no = $1 AND drive_file_id IS NULL AND archived_at IS NULL LIMIT 1', [series])
        : { rowCount: 0, rows: [] as any[] };
      if (match.rowCount) {
        await query('UPDATE videos SET drive_file_id = $2, drive_url = $3, duration_seconds = $4, thumbnail_url = COALESCE(thumbnail_url, $5), updated_at = now() WHERE id = $1', [match.rows[0].id, f.id, f.webViewLink, duration, thumb?.webViewLink ?? null]);
        linked++;
      } else {
        await query(
          `INSERT INTO videos (source_key, title, series_no, drive_file_id, drive_url, duration_seconds, thumbnail_url, campaign_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,(SELECT id FROM campaigns WHERE slug = $8))`,
          [`drive:${f.id}`, title, Number.isFinite(series) ? series : null, f.id, f.webViewLink, duration, thumb?.webViewLink ?? null, brand.libraryCampaignSlug],
        );
        created++;
      }
    }
    const summary = { files: files.length, videos: videos.length, created, linked, unchanged };
    await query(`UPDATE workflow_runs SET status='succeeded', finished_at=now(), response=$2 WHERE id=$1`, [run[0].id, JSON.stringify(summary)]);
    await query(`UPDATE connections SET status='connected', last_success_at=now(), last_checked_at=now() WHERE key='google_drive'`);
    await audit({ actor: user, action: 'drive.sync', entityType: 'video', entityId: driveFolderId(), next: summary, result: 'success', executionId: run[0].id });
    return summary;
  } catch (e) {
    const msg = (e as Error).message;
    await query(`UPDATE workflow_runs SET status='failed', finished_at=now(), error=$2 WHERE id=$1`, [run[0].id, msg]);
    await query(`UPDATE connections SET status='disconnected', last_error=$1, last_error_at=now() WHERE key='google_drive'`, [msg]);
    await audit({ actor: user, action: 'drive.sync', entityType: 'video', result: 'failure', detail: msg, executionId: run[0].id });
    throw new HttpError(502, `Drive import failed: ${msg}`);
  }
}

/**
 * Attach a YouTube video that the channel sync added as its own record to the library record it
 * belongs to: the YouTube fields move over and the duplicate is archived. Nothing on YouTube changes.
 */
export async function mergeYoutubeRecord(targetId: string, duplicateId: string, user: SessionUser) {
  if (targetId === duplicateId) throw new HttpError(400, 'Choose two different records.');
  return tx(async (client) => {
    const { rows } = await client.query('SELECT * FROM videos WHERE id = ANY($1) FOR UPDATE', [[targetId, duplicateId]]);
    const target = rows.find((r) => r.id === targetId);
    const dup = rows.find((r) => r.id === duplicateId);
    if (!target || !dup) throw new HttpError(404, 'Video not found.');
    if (!dup.youtube_video_id) throw new HttpError(400, 'The second record has no YouTube video to move.');
    if (target.youtube_video_id && target.youtube_video_id !== dup.youtube_video_id) throw new HttpError(409, `${target.ref} is already linked to another YouTube video.`);
    const yt = ['youtube_video_id', 'youtube_url', 'youtube_status', 'youtube_privacy', 'youtube_publish_at', 'youtube_title', 'youtube_views', 'youtube_synced_at'];
    await client.query(`UPDATE videos SET youtube_video_id = NULL, archived_at = COALESCE(archived_at, now()), updated_at = now() WHERE id = $1`, [duplicateId]);
    await client.query(
      `UPDATE videos SET ${yt.map((c, i) => `${c} = $${i + 2}`).join(', ')},
         duration_seconds = COALESCE(duration_seconds, $${yt.length + 2}), thumbnail_url = COALESCE(thumbnail_url, $${yt.length + 3}), updated_at = now()
       WHERE id = $1`,
      [targetId, ...yt.map((c) => dup[c]), dup.duration_seconds, dup.thumbnail_url],
    );
    await client.query(`UPDATE youtube_playlist_items SET video_id = $1 WHERE video_id = $2`, [targetId, duplicateId]).catch(() => undefined);
    await audit({ actor: user, action: 'video.merge_youtube', entityType: 'video', entityId: targetId, previous: { duplicate: dup.ref }, next: { youtube_video_id: dup.youtube_video_id, youtube_title: dup.youtube_title }, result: 'success', detail: `${dup.ref} merged into ${target.ref}` }, client);
    return { target: target.ref, duplicate: dup.ref, youtube_video_id: dup.youtube_video_id as string };
  });
}