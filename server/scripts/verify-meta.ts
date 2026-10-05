// Service-level checks for the Meta integration. Uses a deliberately fake token, so nothing can post.
import sharp from 'sharp';
import { pool, query } from '../db/pool.js';
import { signedMediaUrl, listPages } from '../services/meta.js';
import { dispatchDue } from '../services/queue.js';

let failures = 0;
const check = (name: string, ok: boolean, extra = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};

// 1. Signed media links: find a Drive image that is reachable by link.
const imgs = (await query(`SELECT id FROM assets WHERE kind = 'image' AND drive_file_id IS NOT NULL ORDER BY created_at DESC LIMIT 12`)).rows;
let served = false;
for (const a of imgs) {
  const res = await fetch(signedMediaUrl(a.id, { jpeg: true }));
  if (res.status !== 200) continue;
  served = true;
  check('signed link serves the image as JPEG', res.headers.get('content-type') === 'image/jpeg');
  const feed = Buffer.from(await (await fetch(signedMediaUrl(a.id, { feed: true }))).arrayBuffer());
  const m = await sharp(feed).metadata();
  const ratio = (m.width ?? 1) / (m.height ?? 1);
  check('feed variant fits Instagram 4:5–1.91:1', m.format === 'jpeg' && ratio >= 0.79 && ratio <= 1.92, `${m.width}x${m.height}`);
  const good = new URL(signedMediaUrl(a.id, { jpeg: true }));
  good.searchParams.set('sig', good.searchParams.get('sig')!.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')));
  check('tampered link refused', (await fetch(good)).status === 403);
  check('expired link refused', (await fetch(signedMediaUrl(a.id, { jpeg: true, ttlSeconds: -60 }))).status === 403);
  break;
}
if (!served) console.log('SKIP  none of the sheet images is shared by link; signed-link checks skipped');

// 2. A bad token produces a clear Meta error, not a crash.
process.env.META_SYSTEM_USER_TOKEN = 'fake-token-for-testing';
try {
  await listPages();
  check('fake token rejected by Meta', false, 'unexpectedly succeeded');
} catch (e) {
  const msg = (e as Error).message;
  check('fake token rejected by Meta with a clear message', /^Meta: /.test(msg), msg.slice(0, 120));
}

// 3. Dispatcher: a due Facebook post with a bad token fails definitively and posts nothing.
await query(`INSERT INTO meta_pages (page_id, name, enabled, is_default) VALUES ('100000000000001', 'Verification Page', true, true)`);
await query(`UPDATE connections SET status = 'connected', automation_enabled = true WHERE key = 'facebook'`);
const c = (await query(`INSERT INTO content_items (title, caption, category, approval_status, scheduled_at) VALUES ('Meta dispatcher verification', 'Test caption', 'General', 'approved', now() - interval '5 minutes') RETURNING id, version`)).rows[0];
const t = (await query(`INSERT INTO content_targets (content_id, platform, placement) VALUES ($1, 'facebook', 'feed') RETURNING id`, [c.id])).rows[0];
const q = (await query(`INSERT INTO queue_items (content_id, target_id, run_at, idempotency_key, content_version) VALUES ($1, $2, now() - interval '5 minutes', 'verify-meta-' || gen_random_uuid(), $3) RETURNING id`, [c.id, t.id, c.version])).rows[0];
try {
  await dispatchDue();
  const after = (await query('SELECT state, last_error FROM queue_items WHERE id = $1', [q.id])).rows[0];
  check('dispatcher hands the post to Meta and records the failure', after.state === 'failed' && /^Meta: /.test(after.last_error ?? ''), after.last_error?.slice(0, 100));
  check('API error is treated as definite (no "outcome unknown")', !/Outcome unknown/.test(after.last_error ?? ''));
  const pubs = (await query('SELECT count(*) AS n FROM publications WHERE target_id = $1', [t.id])).rows[0].n;
  check('nothing was recorded as published', pubs === 0);
} finally {
  await query(`UPDATE queue_items SET state = 'cancelled' WHERE id = $1`, [q.id]);
  await query(`UPDATE content_items SET archived_at = now(), publish_status = 'unscheduled' WHERE id = $1`, [c.id]);
  await query(`DELETE FROM meta_pages WHERE page_id = '100000000000001'`);
  await query(`UPDATE connections SET status = 'not_configured', automation_enabled = false WHERE key = 'facebook'`);
}
await pool.end();
process.exit(failures ? 1 : 0);
