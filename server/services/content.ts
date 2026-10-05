import type pg from 'pg';
import { query, tx, type Db } from '../db/pool.js';
import type {
  ApprovalStatus,
  Asset,
  ContentItem,
  ContentTarget,
  Platform,
  SessionUser,
} from '../../shared/domain.js';
import { readinessOf, validateContent } from '../../shared/validation.js';
import { audit, diff } from './audit.js';
import { HttpError } from '../http.js';

const BASE_SELECT = `
  SELECT c.*, cp.name AS campaign_name,
    COALESCE((SELECT json_agg(json_build_object('id', t.id, 'platform', t.platform, 'placement', t.placement, 'account_id', t.account_id)
              ORDER BY t.platform, t.placement) FROM content_targets t WHERE t.content_id = c.id), '[]') AS targets,
    COALESCE((SELECT json_agg(json_build_object('kind', a.kind, 'approved', a.approved))
              FROM assets a WHERE a.content_id = c.id), '[]') AS asset_flags
  FROM content_items c
  LEFT JOIN campaigns cp ON cp.id = c.campaign_id`;

function hydrate(row: any): ContentItem {
  const assets = row.asset_flags as { kind: string; approved: boolean }[];
  const issues = validateContent({
    title: row.title,
    caption: row.caption,
    cta: row.cta,
    description: row.description,
    hashtags: row.hashtags,
    scheduled_at: row.scheduled_at,
    approval_status: row.approval_status,
    archived_at: row.archived_at,
    targets: row.targets,
    assets,
  });
  const { asset_flags, source_key, source_hash, synced_at, created_by, updated_by, ...rest } = row;
  return {
    ...rest,
    asset_count: assets.length,
    approved_asset_count: assets.filter((a) => a.approved).length,
    issues,
    readiness: readinessOf(issues),
  };
}

export interface ContentFilters {
  q?: string;
  campaign_id?: string;
  platform?: Platform;
  category?: string;
  priority?: number;
  approval_status?: ApprovalStatus;
  publish_status?: string;
  readiness?: string;
  from?: string;
  to?: string;
  archived?: 'exclude' | 'only' | 'include';
  video_id?: string;
  missing_assets?: boolean;
  needs_details?: boolean;
}

export async function listContent(
  f: ContentFilters,
  opts: { page?: number; pageSize?: number; sort?: string; dir?: 'asc' | 'desc' } = {},
) {
  const where: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (f.archived === 'only') where.push('c.archived_at IS NOT NULL');
  else if (f.archived !== 'include') where.push('c.archived_at IS NULL');
  if (f.q) {
    const like = p(`%${f.q}%`);
    where.push(`(c.title ILIKE ${like} OR c.caption ILIKE ${like} OR c.notes ILIKE ${like} OR c.ref ILIKE ${like}
      OR c.hashtags ILIKE ${like} OR c.description ILIKE ${like})`);
  }
  if (f.campaign_id) where.push(`c.campaign_id = ${p(f.campaign_id)}`);
  if (f.category) where.push(`c.category = ${p(f.category)}`);
  if (f.priority) where.push(`c.priority = ${p(f.priority)}`);
  if (f.approval_status) where.push(`c.approval_status = ${p(f.approval_status)}`);
  if (f.publish_status) where.push(`c.publish_status = ${p(f.publish_status)}`);
  if (f.video_id) where.push(`c.video_id = ${p(f.video_id)}`);
  if (f.platform) where.push(`EXISTS (SELECT 1 FROM content_targets t WHERE t.content_id = c.id AND t.platform = ${p(f.platform)})`);
  if (f.from) where.push(`c.scheduled_at >= ${p(f.from)}`);
  if (f.to) where.push(`c.scheduled_at < ${p(f.to)}`);
  if (f.missing_assets) where.push(`NOT EXISTS (SELECT 1 FROM assets a WHERE a.content_id = c.id AND a.kind IN ('image','video'))`);

  const sortCols: Record<string, string> = {
    scheduled_at: 'c.scheduled_at',
    title: 'c.title',
    updated_at: 'c.updated_at',
    priority: 'c.priority',
    ref: 'c.ref',
    category: 'c.category',
  };
  const sort = sortCols[opts.sort ?? 'scheduled_at'] ?? 'c.scheduled_at';
  const dir = opts.dir === 'asc' ? 'ASC' : 'DESC';
  const sql = `${BASE_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ${sort} ${dir} NULLS LAST, c.ref DESC`;
  let items = (await query(sql, params)).rows.map(hydrate);

  // Readiness is computed from validation rules, so it is filtered after hydration.
  // Content volume is in the hundreds-to-low-thousands, which keeps this cheap.
  if (f.readiness) items = items.filter((i) => i.readiness === f.readiness);
  if (f.needs_details) items = items.filter((i) => i.issues.some((x) => x.code === 'needs_details'));
  const total = items.length;
  const pageSize = Math.min(Math.max(opts.pageSize ?? 25, 1), 5000);
  const page = Math.max(opts.page ?? 1, 1);
  return { items: items.slice((page - 1) * pageSize, page * pageSize), total, page, pageSize };
}

export async function getContent(id: string, db: Db = undefined as any): Promise<ContentItem> {
  const { rows } = await query(`${BASE_SELECT} WHERE c.id = $1`, [id], db);
  if (!rows[0]) throw new HttpError(404, 'Content record not found.');
  return hydrate(rows[0]);
}

export async function getContentDetail(id: string) {
  const item = await getContent(id);
  const [assets, approvals, queue, publications, runs, activity, related] = await Promise.all([
    query<Asset>('SELECT id, content_id, video_id, kind, url, drive_file_id, label, approved, created_by, created_at, mime, size_bytes, (data IS NOT NULL) AS stored, canva_design_id, brand_check FROM assets WHERE content_id = $1 ORDER BY created_at', [id]),
    query(
      `SELECT a.*, u.name AS actor_name FROM approvals a LEFT JOIN users u ON u.id = a.actor_id
       WHERE a.content_id = $1 ORDER BY a.created_at DESC`,
      [id],
    ),
    query(
      `SELECT q.*, t.platform, t.placement FROM queue_items q JOIN content_targets t ON t.id = q.target_id
       WHERE q.content_id = $1 ORDER BY q.created_at DESC`,
      [id],
    ),
    query('SELECT * FROM publications WHERE content_id = $1 ORDER BY published_at DESC', [id]),
    query(
      `SELECT w.*, u.name AS triggered_by_name FROM workflow_runs w LEFT JOIN users u ON u.id = w.triggered_by
       WHERE w.content_id = $1 ORDER BY w.started_at DESC LIMIT 50`,
      [id],
    ),
    query(
      `SELECT * FROM audit_log WHERE (entity_type = 'content' AND entity_id = $1) OR content_ref = $2
       ORDER BY created_at DESC LIMIT 100`,
      [id, item.ref],
    ),
    query(
      `SELECT id, ref, title, content_type, approval_status, publish_status, scheduled_at FROM content_items
       WHERE archived_at IS NULL AND id <> $1 AND (
         parent_id = $1 OR id = $2 OR ($3::uuid IS NOT NULL AND video_id = $3))
       ORDER BY scheduled_at NULLS LAST LIMIT 20`,
      [id, item.parent_id, item.video_id],
    ),
  ]);
  return {
    item,
    assets: assets.rows,
    approvals: approvals.rows,
    queue: queue.rows,
    publications: publications.rows,
    runs: runs.rows,
    activity: activity.rows,
    related: related.rows,
  };
}

// ---------- Mutations ----------

export interface ContentInput {
  title: string;
  caption?: string | null;
  description?: string | null;
  cta?: string | null;
  hashtags?: string | null;
  notes?: string | null;
  category: string;
  priority?: number | null;
  content_type: string;
  campaign_id?: string | null;
  video_id?: string | null;
  parent_id?: string | null;
  scheduled_at?: string | null;
  timezone: string;
  targets?: { platform: Platform; placement: string; account_id?: string | null }[];
}

const SUBSTANTIVE = ['title', 'caption', 'description', 'cta', 'hashtags', 'scheduled_at', 'content_type'] as const;
const EDITABLE = [
  'title', 'caption', 'description', 'cta', 'hashtags', 'notes', 'category', 'priority',
  'content_type', 'campaign_id', 'video_id', 'parent_id', 'scheduled_at', 'timezone',
] as const;

type TargetInput = { platform: string; placement: string; account_id?: string | null };
async function setTargets(client: pg.PoolClient, contentId: string, targets: TargetInput[]) {
  const current = (await client.query('SELECT id, platform, placement, account_id FROM content_targets WHERE content_id = $1', [contentId])).rows;
  // The account (Facebook Page / Instagram account) is part of a destination's identity.
  const key = (t: TargetInput) => `${t.platform}:${t.placement}${t.account_id ? `@${t.account_id}` : ''}`;
  const wanted = new Set(targets.map(key));
  for (const t of current) {
    if (wanted.has(key(t))) continue;
    const pub = await client.query('SELECT 1 FROM publications WHERE target_id = $1', [t.id]);
    if (pub.rowCount) throw new HttpError(409, `${t.platform} ${t.placement} is already published and cannot be removed.`);
    await client.query(`UPDATE queue_items SET state = 'cancelled', updated_at = now() WHERE target_id = $1 AND state IN ('scheduled','paused','failed')`, [t.id]);
    await client.query('DELETE FROM content_targets WHERE id = $1', [t.id]);
  }
  const have = new Set(current.map(key));
  for (const t of targets) {
    if (have.has(key(t))) continue;
    await client.query('INSERT INTO content_targets (content_id, platform, placement, account_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [
      contentId,
      t.platform,
      t.placement,
      t.account_id ?? null,
    ]);
  }
  return { before: current.map(key).sort(), after: [...wanted].sort() };
}

export async function createContent(input: ContentInput, user: SessionUser) {
  const id = await tx(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO content_items (title, caption, description, cta, hashtags, notes, category, priority,
        content_type, campaign_id, video_id, parent_id, scheduled_at, timezone, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15) RETURNING id, ref`,
      [
        input.title, input.caption ?? null, input.description ?? null, input.cta ?? null, input.hashtags ?? null,
        input.notes ?? null, input.category, input.priority ?? null, input.content_type, input.campaign_id ?? null,
        input.video_id ?? null, input.parent_id ?? null, input.scheduled_at ?? null, input.timezone, user.id,
      ],
    );
    if (input.targets?.length) await setTargets(client, rows[0].id, input.targets);
    await audit({ actor: user, action: 'content.create', entityType: 'content', entityId: rows[0].id, contentRef: rows[0].ref, next: input, result: 'success' }, client);
    return rows[0].id as string;
  });
  return getContent(id);
}

/**
 * Update with optimistic locking. Substantive edits to approved content send it
 * back to draft and cancel any unpublished queue entries, so nothing is ever
 * published in a form an approver has not seen.
 */
export async function updateContent(id: string, input: Partial<ContentInput>, expectedVersion: number, user: SessionUser) {
  return tx(async (client) => {
    const { rows } = await client.query('SELECT * FROM content_items WHERE id = $1 FOR UPDATE', [id]);
    const before = rows[0];
    if (!before) throw new HttpError(404, 'Content record not found.');
    if (before.version !== expectedVersion) {
      throw new HttpError(409, 'This record was changed by someone else. Reload to see the latest version.');
    }
    if (before.archived_at) throw new HttpError(409, 'Archived records are read-only. Restore it first.');
    if (before.publish_status === 'published') {
      throw new HttpError(409, 'Published content is locked. Duplicate it to create a new version.');
    }

    const patch: Record<string, unknown> = {};
    for (const k of EDITABLE) if (k in input) patch[k] = (input as any)[k] ?? null;
    const beforeCmp = { ...before, scheduled_at: before.scheduled_at };
    const { prev, next, changed } = diff(beforeCmp, patch);

    let targetChange: { before: string[]; after: string[] } | null = null;
    if (input.targets) {
      targetChange = await setTargets(client, id, input.targets);
      if (JSON.stringify(targetChange.before) === JSON.stringify(targetChange.after)) targetChange = null;
    }
    if (!changed && !targetChange) return { item: await getContent(id, client), approvalReset: false };

    const substantive = SUBSTANTIVE.some((k) => k in next) || !!targetChange;
    const resetApproval = substantive && ['approved', 'pending'].includes(before.approval_status);
    const sets = Object.keys(next).map((k, i) => `${k} = $${i + 2}`);
    const vals = Object.keys(next).map((k) => next[k]);
    sets.push(`version = version + 1`, `updated_at = now()`, `updated_by = $${vals.length + 2}`, `locally_modified = true`);
    if (resetApproval) sets.push(`approval_status = 'draft'`);
    await client.query(`UPDATE content_items SET ${sets.join(', ')} WHERE id = $1`, [id, ...vals, user.id]);

    let cancelled = 0;
    if (resetApproval) {
      const r = await client.query(
        `UPDATE queue_items SET state = 'cancelled', updated_at = now(), last_error = 'Cancelled: content edited after approval'
         WHERE content_id = $1 AND state IN ('scheduled','paused','failed')`,
        [id],
      );
      cancelled = r.rowCount ?? 0;
      await refreshPublishStatus(client, id);
    }
    if (targetChange) {
      prev.targets = targetChange.before;
      next.targets = targetChange.after;
    }
    if (resetApproval) {
      prev.approval_status = before.approval_status;
      next.approval_status = 'draft';
    }
    await audit(
      {
        actor: user,
        action: 'content.update',
        entityType: 'content',
        entityId: id,
        contentRef: before.ref,
        previous: prev,
        next,
        result: 'success',
        detail: resetApproval ? `Approval reset after substantive edit; ${cancelled} queue entr${cancelled === 1 ? 'y' : 'ies'} cancelled.` : null,
      },
      client,
    );
    return { item: await getContent(id, client), approvalReset: resetApproval };
  });
}

export async function duplicateContent(id: string, user: SessionUser) {
  const src = await getContent(id);
  const copy = await createContent(
    {
      title: `${src.title} (copy)`,
      caption: src.caption,
      description: src.description,
      cta: src.cta,
      hashtags: src.hashtags,
      notes: src.notes,
      category: src.category,
      priority: src.priority,
      content_type: src.content_type,
      campaign_id: src.campaign_id,
      video_id: src.video_id,
      parent_id: src.parent_id,
      scheduled_at: null,
      timezone: src.timezone,
      targets: src.targets.map(({ platform, placement, account_id }) => ({ platform, placement, account_id })),
    },
    user,
  );
  await query(
    `INSERT INTO assets (content_id, kind, url, drive_file_id, label, approved, created_by, data, mime, size_bytes)
     SELECT $2, kind, url, drive_file_id, label, approved, $3, data, mime, size_bytes FROM assets WHERE content_id = $1`,
    [id, copy.id, user.id],
  );
  await audit({ actor: user, action: 'content.duplicate', entityType: 'content', entityId: copy.id, contentRef: copy.ref, previous: { source: src.ref }, next: { ref: copy.ref }, result: 'success' });
  return getContent(copy.id);
}

export async function setArchived(id: string, archived: boolean, user: SessionUser) {
  return tx(async (client) => {
    const { rows } = await client.query('SELECT ref, archived_at, publish_status FROM content_items WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw new HttpError(404, 'Content record not found.');
    if (archived) {
      const live = await client.query(`SELECT 1 FROM queue_items WHERE content_id = $1 AND state = 'dispatching'`, [id]);
      if (live.rowCount) throw new HttpError(409, 'This record is being published right now and cannot be archived.');
      await client.query(`UPDATE queue_items SET state = 'cancelled', updated_at = now(), last_error = 'Cancelled: record archived'
        WHERE content_id = $1 AND state IN ('scheduled','paused','failed')`, [id]);
    }
    await client.query(
      `UPDATE content_items SET archived_at = ${archived ? 'now()' : 'NULL'}, version = version + 1, updated_at = now(), updated_by = $2 WHERE id = $1`,
      [id, user.id],
    );
    await refreshPublishStatus(client, id);
    await audit({ actor: user, action: archived ? 'content.archive' : 'content.restore', entityType: 'content', entityId: id, contentRef: rows[0].ref, previous: { archived_at: rows[0].archived_at }, next: { archived: archived }, result: 'success' }, client);
    return getContent(id, client);
  });
}

// ---------- Approval workflow ----------

type Transition = 'submit' | 'approve' | 'reject' | 'request_revision';
const TRANSITIONS: Record<Transition, { from: ApprovalStatus[]; to: ApprovalStatus; action: string }> = {
  submit: { from: ['draft', 'rejected', 'revision_requested'], to: 'pending', action: 'submitted' },
  approve: { from: ['pending'], to: 'approved', action: 'approved' },
  reject: { from: ['pending', 'approved'], to: 'rejected', action: 'rejected' },
  request_revision: { from: ['pending', 'approved'], to: 'revision_requested', action: 'revision_requested' },
};

export async function transition(id: string, t: Transition, comment: string | null, expectedVersion: number, user: SessionUser) {
  return tx(async (client) => {
    const { rows } = await client.query('SELECT * FROM content_items WHERE id = $1 FOR UPDATE', [id]);
    const c = rows[0];
    if (!c) throw new HttpError(404, 'Content record not found.');
    if (c.version !== expectedVersion) throw new HttpError(409, 'This record changed since you opened it. Reload and review again.');
    if (c.archived_at) throw new HttpError(409, 'Archived records cannot move through approval.');
    const rule = TRANSITIONS[t];
    if (!rule.from.includes(c.approval_status)) {
      throw new HttpError(409, `Cannot ${t.replace('_', ' ')} a record that is "${c.approval_status.replace('_', ' ')}".`);
    }
    if ((t === 'reject' || t === 'request_revision') && !comment?.trim()) {
      throw new HttpError(400, 'Add a comment explaining what needs to change.');
    }
    if (t === 'submit') {
      const item = await getContent(id, client);
      const blocking = item.issues.filter((i) => i.severity === 'error' && !['not_approved', 'schedule_missing'].includes(i.code));
      if (blocking.length) {
        throw new HttpError(422, 'Fix validation errors before submitting.', { issues: blocking });
      }
    }
    if (t === 'reject' || t === 'request_revision') {
      await client.query(`UPDATE queue_items SET state = 'cancelled', updated_at = now(), last_error = $2
        WHERE content_id = $1 AND state IN ('scheduled','paused','failed')`, [id, `Cancelled: ${rule.action.replace('_', ' ')}`]);
    }
    await client.query(
      `UPDATE content_items SET approval_status = $2, version = version + 1, updated_at = now(), updated_by = $3 WHERE id = $1`,
      [id, rule.to, user.id],
    );
    await client.query(
      'INSERT INTO approvals (content_id, action, comment, content_version, actor_id) VALUES ($1,$2,$3,$4,$5)',
      [id, rule.action, comment?.trim() || null, c.version, user.id],
    );
    await refreshPublishStatus(client, id);
    await audit({ actor: user, action: `approval.${t}`, entityType: 'content', entityId: id, contentRef: c.ref, previous: { approval_status: c.approval_status }, next: { approval_status: rule.to, comment }, result: 'success' }, client);
    return getContent(id, client);
  });
}

/** Derive the record-level publish status from its queue and publication rows. */
export async function refreshPublishStatus(db: Db, contentId: string) {
  const { rows } = await db.query(
    `SELECT
       (SELECT count(*) FROM content_targets WHERE content_id = $1) AS targets,
       (SELECT count(*) FROM publications WHERE content_id = $1) AS published,
       (SELECT count(*) FROM queue_items WHERE content_id = $1 AND state = 'dispatching') AS dispatching,
       (SELECT count(*) FROM queue_items WHERE content_id = $1 AND state = 'failed') AS failed,
       (SELECT count(*) FROM queue_items WHERE content_id = $1 AND state = 'scheduled') AS scheduled,
       (SELECT count(*) FROM queue_items WHERE content_id = $1 AND state = 'paused') AS paused`,
    [contentId],
  );
  const r = rows[0];
  let status = 'unscheduled';
  if (r.targets > 0 && r.published >= r.targets) status = 'published';
  else if (r.dispatching > 0) status = 'publishing';
  else if (r.failed > 0) status = 'failed';
  else if (r.scheduled > 0) status = 'queued';
  else if (r.paused > 0) status = 'paused';
  else if (r.published > 0) status = 'partially_published';
  await db.query('UPDATE content_items SET publish_status = $2 WHERE id = $1 AND publish_status <> $2', [contentId, status]);
  return status;
}

// ---------- Assets ----------

export function parseDriveId(url: string): string | null {
  const m = url.match(/\/d\/([A-Za-z0-9_-]{10,})/) ?? url.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  return m ? m[1] : null;
}

/** Media changes after approval send the record back to draft, like any substantive edit. */
async function resetApprovalForMediaChange(db: Db, contentId: string, user: SessionUser, ref: string) {
  const { rows } = await db.query(
    `UPDATE content_items SET approval_status = 'draft', version = version + 1, updated_at = now(), updated_by = $2
     WHERE id = $1 AND approval_status IN ('approved','pending') RETURNING id`,
    [contentId, user.id],
  );
  if (!rows.length) return false;
  await db.query(`UPDATE queue_items SET state = 'cancelled', updated_at = now(), last_error = 'Cancelled: media changed after approval'
    WHERE content_id = $1 AND state IN ('scheduled','paused','failed')`, [contentId]);
  await refreshPublishStatus(db, contentId);
  await audit({ actor: user, action: 'approval.reset', entityType: 'content', entityId: contentId, contentRef: ref, next: { approval_status: 'draft' }, result: 'success', detail: 'Media changed after approval' }, db);
  return true;
}

export async function addAsset(
  contentId: string,
  a: { kind: Asset['kind']; url: string; label?: string | null; approved?: boolean },
  user: SessionUser,
) {
  const c = await getContent(contentId);
  if (c.publish_status === 'published') throw new HttpError(409, 'Published content is locked.');
  if (c.archived_at) throw new HttpError(409, 'Archived records are read-only.');
  return tx(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO assets (content_id, kind, url, drive_file_id, label, approved, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, content_id, video_id, kind, url, drive_file_id, label, approved, created_by, created_at, mime, size_bytes, (data IS NOT NULL) AS stored`,
      [contentId, a.kind, a.url, parseDriveId(a.url), a.label ?? null, a.approved ?? false, user.id],
    );
    await client.query('UPDATE content_items SET locally_modified = true WHERE id = $1', [contentId]);
    await audit({ actor: user, action: 'asset.add', entityType: 'content', entityId: contentId, contentRef: c.ref, next: { kind: a.kind, url: a.url, approved: !!a.approved }, result: 'success' }, client);
    if (a.kind === 'image' || a.kind === 'video') await resetApprovalForMediaChange(client, contentId, user, c.ref);
    return rows[0];
  });
}

const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

/** Refuse links that point at this server's private network instead of the public internet. */
function assertPublicHttps(raw: string) {
  const u = new URL(raw);
  const host = u.hostname.toLowerCase();
  const privateHost =
    host === 'localhost' || host.endsWith('.internal') || host.endsWith('.local') ||
    /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(host) || host === '[::1]';
  if (u.protocol !== 'https:' || privateHost) throw new HttpError(400, 'Only public https:// image links can be imported.');
}

/**
 * Store an image in the dashboard. The bytes are decoded to prove they are a real image (the
 * declared type and file name are not trusted), and Instagram's minimum width is checked.
 */
async function storeImage(
  contentId: string,
  buf: Buffer,
  meta: { url: string; label?: string | null; approved?: boolean; source: 'upload' | 'import' | 'canva' },
  user: SessionUser,
) {
  const c = await getContent(contentId);
  if (c.publish_status === 'published') throw new HttpError(409, 'Published content is locked.');
  if (c.archived_at) throw new HttpError(409, 'Archived records are read-only.');
  if (!buf.length) throw new HttpError(400, 'The file is empty.');
  if (buf.length > MAX_IMPORT_BYTES) throw new HttpError(413, 'Images must be 20 MB or smaller.');
  const sharp = (await import('sharp')).default;
  let info: { format?: string; width?: number; height?: number };
  try {
    info = await sharp(buf).metadata();
  } catch {
    throw new HttpError(400, 'That file is not a readable image. Use JPG, PNG or WebP.');
  }
  const mimeByFormat: Record<string, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
  const mime = mimeByFormat[info.format ?? ''];
  if (!mime) throw new HttpError(400, `Unsupported image format (${info.format ?? 'unknown'}). Use JPG, PNG or WebP.`);
  if ((info.width ?? 0) < 320) throw new HttpError(400, `The image is ${info.width}px wide; Instagram needs at least 320px.`);
  return tx(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO assets (content_id, kind, url, label, approved, created_by, data, mime, size_bytes)
       VALUES ($1, 'image', $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, content_id, kind, url, label, approved, created_at, mime, size_bytes, true AS stored`,
      [contentId, meta.url, meta.label ?? null, meta.approved ?? false, user.id, buf, mime, buf.length],
    );
    await client.query('UPDATE content_items SET locally_modified = true WHERE id = $1', [contentId]);
    await audit({ actor: user, action: `asset.${meta.source}`, entityType: 'content', entityId: contentId, contentRef: c.ref, next: { label: meta.label, bytes: buf.length, mime, size: `${info.width}x${info.height}`, approved: !!meta.approved }, result: 'success' }, client);
    await resetApprovalForMediaChange(client, contentId, user, c.ref);
    return rows[0];
  });
}

/** Download an image once and keep a copy (for links that expire, such as Canva exports). */
export async function importAsset(contentId: string, a: { url: string; label?: string | null; approved?: boolean }, user: SessionUser) {
  assertPublicHttps(a.url);
  const res = await fetch(a.url, { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
  if (!res.ok || !res.body) throw new HttpError(502, `Could not download the image (HTTP ${res.status}). The link may have expired.`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_IMPORT_BYTES) throw new HttpError(413, 'Images must be 20 MB or smaller.');
  const buf = Buffer.from(await res.arrayBuffer());
  return storeImage(contentId, buf, { url: a.url.split('?')[0], label: a.label, approved: a.approved, source: 'import' }, user);
}

/** Store an image uploaded from the user's computer. */
export async function uploadAsset(contentId: string, buf: Buffer, a: { filename: string; label?: string | null; approved?: boolean }, user: SessionUser) {
  const name = a.filename.replace(/[^\w.\- ()]/g, '_').slice(0, 120) || 'image';
  return storeImage(contentId, buf, { url: `upload://${name}`, label: a.label || name, approved: a.approved, source: 'upload' }, user);
}

/** Store an image made in Canva. Always unapproved: an approver must review generated media. */
export function storeGeneratedImage(contentId: string, buf: Buffer, a: { url: string; label: string }, user: SessionUser) {
  return storeImage(contentId, buf, { ...a, approved: false, source: 'canva' }, user);
}

/** Stored bytes for an asset (for previews by signed-in users). */
export async function assetFile(assetId: string) {
  const { rows } = await query('SELECT data, mime FROM assets WHERE id = $1 AND data IS NOT NULL', [assetId]);
  if (!rows[0]) throw new HttpError(404, 'No stored file for this asset.');
  return rows[0] as { data: Buffer; mime: string };
}
export async function updateAsset(assetId: string, patch: { approved?: boolean; label?: string | null }, user: SessionUser) {
  const { rows } = await query('SELECT a.*, c.ref FROM assets a LEFT JOIN content_items c ON c.id = a.content_id WHERE a.id = $1', [assetId]);
  const before = rows[0];
  if (!before) throw new HttpError(404, 'Asset not found.');
  if (patch.approved === true && !before.approved && before.brand_check?.status === 'fail') {
    throw new HttpError(409, `Brand check failed: ${before.brand_check.detail} Fix the logo first.`);
  }
  const next = {
    approved: patch.approved ?? before.approved,
    label: patch.label !== undefined ? patch.label : before.label,
  };
  await query('UPDATE assets SET approved = $2, label = $3 WHERE id = $1', [assetId, next.approved, next.label]);
  await audit({ actor: user, action: 'asset.update', entityType: 'content', entityId: before.content_id, contentRef: before.ref, previous: { approved: before.approved, label: before.label }, next, result: 'success' });
}

export async function removeAsset(assetId: string, user: SessionUser) {
  const { rows } = await query('SELECT a.*, c.ref, c.publish_status FROM assets a LEFT JOIN content_items c ON c.id = a.content_id WHERE a.id = $1', [assetId]);
  const a = rows[0];
  if (!a) throw new HttpError(404, 'Asset not found.');
  if (a.publish_status === 'published') throw new HttpError(409, 'Assets on published content are locked.');
  await tx(async (client) => {
    await client.query('DELETE FROM assets WHERE id = $1', [assetId]);
    await audit({ actor: user, action: 'asset.remove', entityType: 'content', entityId: a.content_id, contentRef: a.ref, previous: { kind: a.kind, url: a.url }, result: 'success' }, client);
    if (a.content_id && (a.kind === 'image' || a.kind === 'video')) await resetApprovalForMediaChange(client, a.content_id, user, a.ref);
  });
}

export type { ContentTarget };
