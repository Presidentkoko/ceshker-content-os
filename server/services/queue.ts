import crypto from 'node:crypto';
import { pool, query, tx } from '../db/pool.js';
import type { Platform, SessionUser } from '../../shared/domain.js';
import { PLATFORM_CONNECTION } from '../../shared/domain.js';
import { publishBlockers } from '../../shared/validation.js';
import { audit } from './audit.js';
import { getContent, refreshPublishStatus } from './content.js';
import { platformConnectionState } from './connections.js';
import { callN8n, n8nConfigured } from './n8n.js';
import { metaTokenConfigured, resolveAccount } from './meta.js';
import { HttpError } from '../http.js';

/** How long past its slot a queued post may still go out. After that it fails and must be rescheduled. */
export const MISSED_WINDOW_MS = 2 * 60 * 60 * 1000;

const idempotencyKey = (targetId: string, version: number, runAt: string) =>
  crypto.createHash('sha256').update(`${targetId}:${version}:${runAt}`).digest('hex').slice(0, 32);

async function assertQueueable(contentId: string) {
  const item = await getContent(contentId);
  const errors = item.issues.filter((i) => i.severity === 'error');
  if (errors.length) throw new HttpError(422, 'This record is not ready to queue.', { issues: errors });
  return item;
}

export async function enqueue(contentId: string, expectedVersion: number, user: SessionUser) {
  const item = await assertQueueable(contentId);
  if (item.version !== expectedVersion) throw new HttpError(409, 'This record changed since you opened it. Reload and review again.');
  return tx(async (client) => {
    const pubs = new Set((await client.query('SELECT target_id FROM publications WHERE content_id = $1', [contentId])).rows.map((r) => r.target_id));
    const live = new Set(
      (await client.query(`SELECT target_id FROM queue_items WHERE content_id = $1 AND state IN ('scheduled','paused','dispatching','failed')`, [contentId])).rows.map((r) => r.target_id),
    );
    const added: string[] = [];
    for (const t of item.targets) {
      if (pubs.has(t.id) || live.has(t.id)) continue;
      await client.query(
        `INSERT INTO queue_items (content_id, target_id, run_at, idempotency_key, content_version, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [contentId, t.id, item.scheduled_at, idempotencyKey(t.id, item.version, item.scheduled_at!), item.version, user.id],
      );
      added.push(`${t.platform}:${t.placement}`);
    }
    if (!added.length) throw new HttpError(409, 'Every destination is already queued or published.');
    await refreshPublishStatus(client, contentId);
    await audit({ actor: user, action: 'queue.add', entityType: 'content', entityId: contentId, contentRef: item.ref, next: { targets: added, run_at: item.scheduled_at }, result: 'success' }, client);
    return { added };
  });
}

async function loadQueueItem(id: string, client: any) {
  const { rows } = await client.query(
    `SELECT q.*, c.ref, t.platform, t.placement FROM queue_items q
     JOIN content_items c ON c.id = q.content_id JOIN content_targets t ON t.id = q.target_id
     WHERE q.id = $1 FOR UPDATE OF q`,
    [id],
  );
  if (!rows[0]) throw new HttpError(404, 'Queue item not found.');
  return rows[0];
}

export async function setPaused(id: string, paused: boolean, user: SessionUser) {
  return tx(async (client) => {
    const q = await loadQueueItem(id, client);
    const from = paused ? 'scheduled' : 'paused';
    if (q.state !== from) throw new HttpError(409, `Only ${from} items can be ${paused ? 'paused' : 'resumed'} (this one is ${q.state}).`);
    if (!paused && new Date(q.run_at).getTime() < Date.now() - MISSED_WINDOW_MS) {
      throw new HttpError(409, 'The scheduled time has passed. Reschedule instead of resuming.');
    }
    await client.query('UPDATE queue_items SET state = $2, updated_at = now() WHERE id = $1', [id, paused ? 'paused' : 'scheduled']);
    await refreshPublishStatus(client, q.content_id);
    await audit({ actor: user, action: paused ? 'queue.pause' : 'queue.resume', entityType: 'content', entityId: q.content_id, contentRef: q.ref, previous: { state: q.state }, next: { state: paused ? 'paused' : 'scheduled', target: `${q.platform}:${q.placement}` }, result: 'success' }, client);
  });
}

export async function cancelQueueItem(id: string, user: SessionUser) {
  return tx(async (client) => {
    const q = await loadQueueItem(id, client);
    if (!['scheduled', 'paused', 'failed'].includes(q.state)) throw new HttpError(409, `A ${q.state} item cannot be removed from the queue.`);
    await client.query(`UPDATE queue_items SET state = 'cancelled', updated_at = now() WHERE id = $1`, [id]);
    await refreshPublishStatus(client, q.content_id);
    await audit({ actor: user, action: 'queue.remove', entityType: 'content', entityId: q.content_id, contentRef: q.ref, previous: { state: q.state }, next: { state: 'cancelled' }, result: 'success' }, client);
  });
}

/** Reschedule a record: moves its scheduled time and every live queue entry together. */
export async function reschedule(contentId: string, scheduledAt: string, expectedVersion: number, user: SessionUser) {
  if (Number.isNaN(Date.parse(scheduledAt))) throw new HttpError(400, 'Invalid date.');
  if (new Date(scheduledAt).getTime() < Date.now() - 60_000) throw new HttpError(400, 'Choose a time in the future.');
  return tx(async (client) => {
    const { rows } = await client.query('SELECT ref, version, scheduled_at, archived_at, publish_status FROM content_items WHERE id = $1 FOR UPDATE', [contentId]);
    const c = rows[0];
    if (!c) throw new HttpError(404, 'Content record not found.');
    if (c.version !== expectedVersion) throw new HttpError(409, 'This record changed since you opened it. Reload first.');
    if (c.archived_at) throw new HttpError(409, 'Archived records cannot be rescheduled.');
    if (c.publish_status === 'published') throw new HttpError(409, 'Already published.');
    if (c.publish_status === 'publishing') throw new HttpError(409, 'This record is publishing right now.');
    // Rescheduling does not change what the approver saw, so approval is kept.
    await client.query('UPDATE content_items SET scheduled_at = $2, version = version + 1, updated_at = now(), updated_by = $3, locally_modified = true WHERE id = $1', [contentId, scheduledAt, user.id]);
    const moved = await client.query(
      `UPDATE queue_items SET run_at = $2, content_version = content_version + 1,
         state = CASE WHEN state = 'failed' THEN 'scheduled' ELSE state END,
         idempotency_key = encode(sha256((target_id::text || ':' || $2::text)::bytea), 'hex'), last_error = NULL, updated_at = now()
       WHERE content_id = $1 AND state IN ('scheduled','paused','failed') RETURNING id`,
      [contentId, scheduledAt],
    );
    await refreshPublishStatus(client, contentId);
    await audit({ actor: user, action: 'content.reschedule', entityType: 'content', entityId: contentId, contentRef: c.ref, previous: { scheduled_at: c.scheduled_at }, next: { scheduled_at: scheduledAt, queue_entries_moved: moved.rowCount }, result: 'success' }, client);
  });
}

function buildPayload(item: Awaited<ReturnType<typeof getContent>>, target: { id: string; platform: Platform; placement: string; account_id?: string | null }, assets: any[]) {
  const media = assets.filter((a) => a.approved && (a.kind === 'image' || a.kind === 'video'));
  const thumb = assets.find((a) => a.kind === 'thumbnail');
  const text = [item.caption, item.cta, item.hashtags].filter(Boolean).join('\n\n');
  const base = {
    content_id: item.id,
    content_ref: item.ref,
    content_version: item.version,
    target_id: target.id,
    platform: target.platform,
    placement: target.placement,
    account_id: target.account_id ?? null,
    scheduled_at: item.scheduled_at,
    timezone: item.timezone,
    media: media.map((m) => ({ kind: m.kind, url: m.url, drive_file_id: m.drive_file_id })),
  };
  if (target.platform === 'youtube') {
    return { ...base, title: item.title, description: [item.description || item.caption, item.cta].filter(Boolean).join('\n\n'), thumbnail: thumb?.url ?? null, privacy: 'private', publish_at: item.scheduled_at };
  }
  return { ...base, message: text };
}

/**
 * Dry run: re-validates, builds the exact per-destination payloads and, when
 * n8n is configured, sends them with dry_run=true so the workflow can check
 * credentials and media without posting anything.
 */
export async function dryRun(contentId: string, user: SessionUser) {
  const item = await getContent(contentId);
  const assets = (await query('SELECT id, content_id, video_id, kind, url, drive_file_id, label, approved, created_by, created_at, mime, size_bytes, (data IS NOT NULL) AS stored FROM assets WHERE content_id = $1', [contentId])).rows;
  const connections = await platformConnectionState();
  const blockers = publishBlockers(item.targets.filter((t) => PLATFORM_CONNECTION[t.platform]), connections);
  // Resolve where each Facebook/Instagram destination would post, so the approver sees the exact Page.
  const destinations: string[] = [];
  if (metaTokenConfigured()) {
    for (const t of item.targets.filter((x) => x.platform === 'facebook' || x.platform === 'instagram')) {
      try {
        const page = await resolveAccount(t.platform as 'facebook' | 'instagram', t.account_id ?? null);
        destinations.push(`${t.platform} ${t.placement} → ${t.platform === 'instagram' ? '@' + page.ig_username : page.name}`);
      } catch (e) {
        blockers.push({ code: 'meta_account', severity: 'error', platform: t.platform, message: (e as Error).message });
      }
    }
  }
  const payloads = item.targets.map((t) => buildPayload(item, t, assets));
  const contentErrors = item.issues.filter((i) => i.severity === 'error');

  const { rows } = await query(
    `INSERT INTO workflow_runs (kind, content_id, summary, triggered_by, request) VALUES ('dry_run', $1, $2, $3, $4) RETURNING id`,
    [contentId, `Dry run ${item.ref}`, user.id, JSON.stringify({ payloads })],
  );
  const runId = rows[0].id;
  let n8n: Awaited<ReturnType<typeof callN8n>> | null = null;
  if (n8nConfigured() && !metaTokenConfigured() && !contentErrors.length) {
    n8n = await callN8n({ action: 'publish', dry_run: true, run_id: runId, payloads });
  }
  const ok = contentErrors.length === 0 && (!n8n || n8n.ok);
  const result = {
    ok,
    content_errors: contentErrors,
    warnings: item.issues.filter((i) => i.severity === 'warning'),
    publish_blockers: blockers,
    destinations,
    payloads,
    n8n: n8n ? { sent: true, ok: n8n.ok, execution_id: n8n.executionId, error: n8n.error, response: n8n.body } : { sent: false, reason: contentErrors.length ? 'Validation errors' : 'n8n webhook not configured' },
  };
  await query(`UPDATE workflow_runs SET status = $2, finished_at = now(), response = $3, error = $4, execution_id = $5 WHERE id = $1`, [
    runId, ok ? 'succeeded' : 'failed', JSON.stringify(result), ok ? null : contentErrors.map((e) => e.message).join(' ') || n8n?.error || null, n8n?.executionId ?? null,
  ]);
  await audit({ actor: user, action: 'workflow.dry_run', entityType: 'content', entityId: contentId, contentRef: item.ref, executionId: n8n?.executionId ?? runId, result: ok ? 'success' : 'failure', detail: `${blockers.length} live-publish blocker(s)` });
  return { run_id: runId, ...result };
}

/** Retry a failed queue item: re-validated, same idempotency key so n8n can de-duplicate. */
export async function retry(queueId: string, user: SessionUser) {
  return tx(async (client) => {
    const q = await loadQueueItem(queueId, client);
    if (q.state !== 'failed') throw new HttpError(409, 'Only failed items can be retried.');
    const pub = await client.query('SELECT 1 FROM publications WHERE target_id = $1', [q.target_id]);
    if (pub.rowCount) {
      await client.query(`UPDATE queue_items SET state = 'published', updated_at = now() WHERE id = $1`, [queueId]);
      throw new HttpError(409, 'This destination was already published; the retry was blocked to prevent a duplicate post.');
    }
    const item = await getContent(q.content_id, client);
    const errors = item.issues.filter((i) => i.severity === 'error');
    if (errors.length) throw new HttpError(422, 'Fix validation errors before retrying.', { issues: errors });
    if (item.version !== q.content_version) throw new HttpError(409, 'Content changed since this was queued. Re-queue it instead.');
    await client.query(`UPDATE queue_items SET state = 'scheduled', run_at = GREATEST(run_at, now()), last_error = NULL, updated_at = now() WHERE id = $1`, [queueId]);
    await refreshPublishStatus(client, q.content_id);
    await audit({ actor: user, action: 'queue.retry', entityType: 'content', entityId: q.content_id, contentRef: q.ref, previous: { state: 'failed', last_error: q.last_error }, next: { state: 'scheduled' }, result: 'success' }, client);
  });
}

/** Record a post that the team published by hand, with its public URL. */
export async function recordManualPublication(
  contentId: string,
  input: { target_id: string; public_url?: string | null; platform_post_id?: string | null; published_at?: string | null },
  user: SessionUser,
) {
  return tx(async (client) => {
    const item = await getContent(contentId, client);
    const target = item.targets.find((t) => t.id === input.target_id);
    if (!target) throw new HttpError(404, 'Destination not found on this record.');
    if (item.approval_status !== 'approved') throw new HttpError(409, 'Only approved content can be recorded as published.');
    const live = await client.query(`SELECT 1 FROM queue_items WHERE target_id = $1 AND state = 'dispatching'`, [target.id]);
    if (live.rowCount) throw new HttpError(409, 'An automated publish is in progress for this destination.');
    await client.query(
      `INSERT INTO publications (content_id, target_id, platform, method, platform_post_id, public_url, published_at)
       VALUES ($1,$2,$3,'manual',$4,$5,COALESCE($6::timestamptz, now()))`,
      [contentId, target.id, target.platform, input.platform_post_id ?? null, input.public_url ?? null, input.published_at ?? null],
    );
    await client.query(`UPDATE queue_items SET state = 'cancelled', last_error = 'Published manually', updated_at = now() WHERE target_id = $1 AND state IN ('scheduled','paused','failed')`, [target.id]);
    await refreshPublishStatus(client, contentId);
    await audit({ actor: user, action: 'publication.record_manual', entityType: 'content', entityId: contentId, contentRef: item.ref, next: { target: `${target.platform}:${target.placement}`, public_url: input.public_url }, result: 'success' }, client);
  });
}

// ---------- Dispatcher ----------

async function failItem(id: string, contentId: string, ref: string, message: string, runId?: string, executionId?: string | null) {
  await query(`UPDATE queue_items SET state = 'failed', last_error = $2, updated_at = now() WHERE id = $1`, [id, message]);
  await refreshPublishStatus(pool, contentId);
  await audit({ actor: null, action: 'publish.fail', entityType: 'content', entityId: contentId, contentRef: ref, executionId: executionId ?? runId ?? null, result: 'failure', detail: message });
}

/**
 * One dispatcher pass. Claims due items with SKIP LOCKED so multiple replicas
 * never pick the same row, re-checks every safeguard, then hands off to n8n.
 */
export async function dispatchDue(limit = 10) {
  // Reconcile: a hand-off with no result after 15 minutes is marked failed with an
  // explicit "outcome unknown" note, so a person checks the platform before any retry.
  const stale = await query(
    `UPDATE queue_items q SET state = 'failed', updated_at = now(),
       last_error = 'No result from n8n within 15 minutes. Outcome unknown: check the platform before retrying.'
     WHERE q.state = 'dispatching' AND q.updated_at < now() - interval '15 minutes' RETURNING q.content_id`,
  );
  for (const r of stale.rows) await refreshPublishStatus(pool, r.content_id);
  await query(`UPDATE workflow_runs SET status = 'failed', finished_at = now(), error = 'Timed out waiting for n8n'
    WHERE kind = 'publish' AND status = 'running' AND started_at < now() - interval '15 minutes'`);

  const claimed = await tx(async (client) => {
    const { rows } = await client.query(
      `SELECT q.id FROM queue_items q WHERE q.state = 'scheduled' AND q.run_at <= now()
       ORDER BY q.run_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    return rows.map((r) => r.id as string);
  });

  const connections = await platformConnectionState();
  for (const id of claimed) {
    const { rows } = await query(
      `SELECT q.*, c.ref, t.platform, t.placement, t.account_id FROM queue_items q JOIN content_items c ON c.id = q.content_id
       JOIN content_targets t ON t.id = q.target_id WHERE q.id = $1`,
      [id],
    );
    const q = rows[0];
    if (!q || q.state !== 'scheduled') continue;
    const already = await query('SELECT 1 FROM publications WHERE target_id = $1', [q.target_id]);
    if (already.rowCount) {
      await query(`UPDATE queue_items SET state = 'published', updated_at = now() WHERE id = $1`, [id]);
      await refreshPublishStatus(pool, q.content_id);
      continue;
    }
    const item = await getContent(q.content_id);
    const overdue = Date.now() - new Date(q.run_at).getTime() > MISSED_WINDOW_MS;
    const blockers = publishBlockers([{ platform: q.platform }], connections);
    const errors = item.issues.filter((i) => i.severity === 'error');

    if (errors.length || item.version !== q.content_version) {
      await failItem(id, q.content_id, q.ref, errors.length ? `Blocked by validation: ${errors.map((e) => e.message).join(' ')}` : 'Content changed after it was queued.');
      continue;
    }
    // YouTube uses the dashboard's Google connection; Facebook/Instagram use the Meta system-user token.
    const viaMeta = (q.platform === 'facebook' || q.platform === 'instagram') && metaTokenConfigured();
    const direct = q.platform === 'youtube' || viaMeta;
    if (blockers.length || (!direct && !n8nConfigured())) {
      // Wait for access inside the window; fail once the slot is missed rather than posting late.
      if (overdue) await failItem(id, q.content_id, q.ref, `Missed publishing window: ${blockers.map((b) => b.message).join(' ') || 'n8n webhook not configured.'}`);
      continue;
    }
    if (overdue) {
      await failItem(id, q.content_id, q.ref, 'Missed publishing window by more than 2 hours. Reschedule to publish.');
      continue;
    }
    const claim = await query(`UPDATE queue_items SET state = 'dispatching', attempts = attempts + 1, updated_at = now() WHERE id = $1 AND state = 'scheduled' RETURNING id`, [id]);
    if (!claim.rowCount) continue;
    await refreshPublishStatus(pool, q.content_id);

    const assets = (await query('SELECT id, content_id, video_id, kind, url, drive_file_id, label, approved, created_by, created_at, mime, size_bytes, (data IS NOT NULL) AS stored FROM assets WHERE content_id = $1', [q.content_id])).rows;
    const payload = buildPayload(item, { id: q.target_id, platform: q.platform, placement: q.placement, account_id: q.account_id }, assets);
    const { rows: run } = await query(
      `INSERT INTO workflow_runs (kind, content_id, queue_item_id, summary, request) VALUES ('publish', $1, $2, $3, $4) RETURNING id`,
      [q.content_id, id, `Publish ${q.ref} to ${q.platform}`, JSON.stringify(payload)],
    );
    if (direct) {
      try {
        if (viaMeta) {
          const { publish } = await import('./meta.js');
          const media = assets.filter((a) => a.approved && (a.kind === 'image' || a.kind === 'video')).map((a) => ({ id: a.id as string, kind: a.kind as 'image' | 'video' }));
          const r = await publish({ platform: q.platform, placement: q.placement, account_id: q.account_id ?? null, message: (payload as any).message ?? '', media });
          await query(`UPDATE workflow_runs SET execution_id = $2 WHERE id = $1`, [run[0].id, r.id]);
          await completePublication({ run_id: run[0].id, ok: true, platform_post_id: r.id, public_url: r.url, execution_id: r.id });
          continue;
        }
        // YouTube: stream the approved Drive video through the dashboard's Google connection.
        const video = assets.find((a) => a.approved && a.kind === 'video' && a.drive_file_id);
        if (!video) throw new Error('No approved Drive video asset to upload.');
        const { uploadDriveFile } = await import('./youtube.js');
        const yv = await uploadDriveFile(
          video.drive_file_id,
          { title: item.title.slice(0, 100), description: [item.description || item.caption, item.cta].filter(Boolean).join('\n\n'), categoryId: '27' },
          { privacyStatus: 'public', selfDeclaredMadeForKids: false },
        );
        await query(`UPDATE workflow_runs SET execution_id = $2 WHERE id = $1`, [run[0].id, yv.id]);
        await completePublication({ run_id: run[0].id, ok: true, platform_post_id: yv.id, public_url: `https://youtu.be/${yv.id}`, execution_id: yv.id });
      } catch (e) {
        await query(`UPDATE workflow_runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`, [run[0].id, (e as Error).message]);
        // A Meta/YouTube API error means nothing was posted; a dropped connection or timeout is ambiguous.
        const definite = e instanceof HttpError;
        const msg = q.platform === 'youtube' ? `YouTube: ${(e as Error).message}` : (e as Error).message;
        await failItem(id, q.content_id, q.ref, definite ? msg : `Outcome unknown: check the ${q.platform === 'youtube' ? 'channel' : 'Page'} before retrying. (${msg})`, run[0].id);
      }
      continue;
    }
    const res = await callN8n({ action: 'publish', dry_run: false, run_id: run[0].id, idempotency_key: q.idempotency_key, payloads: [payload] }, 60_000);
    await query(`UPDATE workflow_runs SET execution_id = $2, response = $3 WHERE id = $1`, [run[0].id, res.executionId, JSON.stringify(res.body)]);
    if (!res.ok) {
      await query(`UPDATE workflow_runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`, [run[0].id, res.error]);
      await failItem(id, q.content_id, q.ref, res.error ?? 'n8n reported a failure.', run[0].id, res.executionId);
      continue;
    }
    // n8n may answer synchronously with the platform result, or later via the callback endpoint.
    const r = res.body?.results?.[0] ?? res.body;
    if (r?.platform_post_id || r?.public_url) {
      await completePublication({ run_id: run[0].id, ok: true, platform_post_id: r.platform_post_id, public_url: r.public_url, execution_id: res.executionId });
    }
  }
  return claimed.length;
}

/** Called for synchronous n8n replies and by the signed n8n callback. */
export async function completePublication(input: {
  run_id: string;
  ok: boolean;
  platform_post_id?: string | null;
  public_url?: string | null;
  error?: string | null;
  execution_id?: string | null;
}) {
  return tx(async (client) => {
    const { rows } = await client.query(
      `SELECT w.*, q.target_id, q.content_id AS q_content_id, q.state AS q_state, c.ref, t.platform FROM workflow_runs w
       JOIN queue_items q ON q.id = w.queue_item_id JOIN content_items c ON c.id = q.content_id
       JOIN content_targets t ON t.id = q.target_id WHERE w.id = $1 AND w.kind = 'publish' FOR UPDATE OF w, q`,
      [input.run_id],
    );
    const w = rows[0];
    if (!w) throw new HttpError(404, 'Unknown publish run.');
    if (w.status !== 'running') return { alreadyFinal: true };
    if (input.ok) {
      await client.query(
        `INSERT INTO publications (content_id, target_id, platform, method, platform_post_id, public_url, execution_id)
         VALUES ($1,$2,$3,'automated',$4,$5,$6) ON CONFLICT (target_id) DO NOTHING`,
        [w.q_content_id, w.target_id, w.platform, input.platform_post_id ?? null, input.public_url ?? null, input.execution_id ?? w.execution_id],
      );
      await client.query(`UPDATE queue_items SET state = 'published', last_error = NULL, updated_at = now() WHERE id = $1`, [w.queue_item_id]);
      await client.query(`UPDATE workflow_runs SET status = 'succeeded', finished_at = now(), execution_id = COALESCE($2, execution_id) WHERE id = $1`, [w.id, input.execution_id ?? null]);
    } else {
      await client.query(`UPDATE queue_items SET state = 'failed', last_error = $2, updated_at = now() WHERE id = $1`, [w.queue_item_id, input.error ?? 'Publishing failed.']);
      await client.query(`UPDATE workflow_runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`, [w.id, input.error ?? null]);
    }
    await refreshPublishStatus(client, w.q_content_id);
    await audit({ actor: null, action: input.ok ? 'publish.succeed' : 'publish.fail', entityType: 'content', entityId: w.q_content_id, contentRef: w.ref, next: { platform: w.platform, public_url: input.public_url, platform_post_id: input.platform_post_id }, executionId: input.execution_id ?? w.execution_id, result: input.ok ? 'success' : 'failure', detail: input.error ?? null }, client);
    return { alreadyFinal: false };
  });
}

let timer: NodeJS.Timeout | null = null;
export function startDispatcher(intervalMs = 30_000) {
  if (timer) return;
  const tick = () => dispatchDue().catch((e) => console.error('dispatcher error', e));
  timer = setInterval(tick, intervalMs);
  timer.unref();
}
