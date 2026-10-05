// Verifies the dispatcher never posts without access and fails items that miss their window.
import { pool, query } from '../db/pool.js';
import { dispatchDue } from '../services/queue.js';
import { parseSheetDate } from '../services/sheetSync.js';

let failures = 0;
const check = (name: string, ok: boolean, extra = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};

check('sheet date: plain', parseSheetDate('September 22, 2026 (Tuesday)', 'America/Chicago') === '2026-09-22T15:00:00.000Z');
check('sheet date: typo month', parseSheetDate('Septmber 4, 2026 (Friday)', 'America/Chicago') === '2026-09-04T15:00:00.000Z');
check('sheet date: PM marker', parseSheetDate('June 25, 2026 (PM, Thursday)', 'America/Chicago') === '2026-06-25T20:00:00.000Z');
check('sheet date: no space before year', parseSheetDate('May 15,2026', 'America/Chicago') === '2026-05-15T15:00:00.000Z');
check('sheet date: blank', parseSheetDate('', 'America/Chicago') === null);

// A temporary approved Facebook post, archived at the end.
const tmp = await query(
  `INSERT INTO content_items (title, caption, category, approval_status, scheduled_at, notes)
   VALUES ('Dispatcher verification (temporary)', 'Verification caption', 'General', 'approved', now() - interval '5 minutes', 'Created by verify-dispatcher') RETURNING id`,
);
await query(`INSERT INTO content_targets (content_id, platform, placement) VALUES ($1, 'facebook', 'feed')`, [tmp.rows[0].id]);
const { rows } = await query(
  `SELECT c.id, c.version, t.id AS target_id FROM content_items c JOIN content_targets t ON t.content_id = c.id WHERE c.id = $1`,
  [tmp.rows[0].id],
);
if (!rows[0]) {
  console.log('SKIP  no approved unpublished target available');
} else {
  const r = rows[0];
  const ins = await query(
    `INSERT INTO queue_items (content_id, target_id, run_at, idempotency_key, content_version)
     VALUES ($1, $2, now() - interval '5 minutes', 'verify-' || gen_random_uuid(), $3) RETURNING id`,
    [r.id, r.target_id, r.version],
  );
  await dispatchDue();
  let q = (await query('SELECT state FROM queue_items WHERE id = $1', [ins.rows[0].id])).rows[0];
  check('due item waits while automation is off (no publish)', q.state === 'scheduled' || q.state === 'failed', q.state);
  const pubs = await query('SELECT count(*) AS n FROM publications WHERE target_id = $1', [r.target_id]);
  check('nothing was published', pubs.rows[0].n === 0);
  await query(`UPDATE queue_items SET run_at = now() - interval '3 hours' WHERE id = $1`, [ins.rows[0].id]);
  await dispatchDue();
  q = (await query('SELECT state, last_error FROM queue_items WHERE id = $1', [ins.rows[0].id])).rows[0];
  check('item past the 2-hour window fails instead of posting late', q.state === 'failed', q.last_error ?? '');
  // Clean up the simulated entry.
  await query(`UPDATE queue_items SET state = 'cancelled' WHERE id = $1`, [ins.rows[0].id]);
  await query(`UPDATE content_items SET publish_status = 'unscheduled', archived_at = now() WHERE id = $1`, [r.id]);
}
await pool.end();
process.exit(failures ? 1 : 0);
