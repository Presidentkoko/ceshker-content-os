import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '../db/pool.js';
import { config } from '../config.js';
import { zonedToUtc } from '../../shared/time.js';

/**
 * Content plans seeded for the AIM / Deal Smith Realty brand:
 *  - the DSR October 2026 calendar (dated, one post per day);
 *  - the AIM 30-day plan as an undated idea bank (its captions are ready; schedule them when there is a gap).
 * Seeding is idempotent by source_key, so edits made in the dashboard are never overwritten.
 */

interface PlanPost {
  key: string;
  title: string;
  type: string;
  category: string;
  caption: string;
  cta: string;
  hashtags: string;
  notes: string;
  scheduledAt: string | null;
  campaignSlug: string;
  placements: string[]; // 'feed' | 'reel'
}

function dataFile(name: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Works from both source (server/scripts) and the compiled build (dist-server/server/scripts).
  for (const p of [path.resolve(here, '../../data', name), path.resolve(here, '../../../data', name)]) {
    try {
      readFileSync(p);
      return p;
    } catch {
      /* try next */
    }
  }
  throw new Error(`data/${name} not found`);
}

async function postTime(): Promise<string> {
  return ((await query(`SELECT value FROM settings WHERE key = 'default_post_time'`)).rows[0]?.value as string | undefined) ?? '10:00';
}

/** DSR October 2026 calendar (revised Sep 30, 2026): 30 dated posts. */
function octoberPosts(time: string): PlanPost[] {
  const plan = JSON.parse(readFileSync(dataFile('dsr-october-2026.json'), 'utf8'));
  return plan.days.map((d: any) => {
    const notes = [
      d.note ? `EDITOR NOTE: ${d.note}` : '',
      `Format: ${d.format}`,
      d.visuals ? `Visuals: ${d.visuals}` : '',
      d.slides?.length ? `${d.type === 'reel' ? 'On-screen text' : 'Slides'}:\n${d.slides.map((s: string, i: number) => `${i + 1}. ${s}`).join('\n')}` : '',
      'Style: black background, gold and white type, real DSR logo only. From the DSR October 2026 calendar (revised).',
    ].filter(Boolean).join('\n\n');
    return {
      key: `plan:dsr-oct-2026:day-${String(d.day).padStart(2, '0')}`,
      title: d.title,
      type: d.type,
      category: d.category,
      caption: d.caption,
      cta: d.cta,
      hashtags: d.hashtags,
      notes,
      scheduledAt: zonedToUtc(d.date, time, config.APP_TIMEZONE).toISOString(),
      campaignSlug: 'dsr-october-2026',
      placements: [d.type === 'reel' ? 'reel' : 'feed'],
    };
  });
}

/** AIM 30-day plan: an undated idea bank. */
function aimPosts(): PlanPost[] {
  const plan = JSON.parse(readFileSync(dataFile('aim-30-day-plan.json'), 'utf8'));
  return plan.days.map((d: any) => ({
    key: `plan:aim-30:day-${String(d.day).padStart(2, '0')}`,
    title: d.title,
    type: d.type,
    category: d.category,
    caption: d.caption,
    cta: d.cta,
    hashtags: plan.hashtags,
    notes: [
      `Idea bank: AIM 30-day plan, week "${d.week}". Undated on purpose; give it a date when there is a gap in the calendar.`,
      `Hook: ${d.hook}`,
      d.slides.length ? `${d.type === 'reel' ? 'On-screen text' : 'Slides'}:\n${d.slides.map((s: string, i: number) => `${i + 1}. ${s}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n'),
    scheduledAt: null,
    campaignSlug: 'aim-30-day',
    placements: [d.type === 'reel' ? 'reel' : 'feed'],
  }));
}

async function seedPost(p: PlanPost, campaigns: Map<string, string>) {
  const exists = await query('SELECT 1 FROM content_items WHERE source_key = $1', [p.key]);
  if (exists.rowCount) return false;
  const { rows } = await query(
    `INSERT INTO content_items (title, caption, cta, hashtags, notes, category, priority, content_type, campaign_id,
       scheduled_at, timezone, approval_status, source, source_key, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,2,$7,$8,$9,$10,'draft','dashboard',$11, now()) RETURNING id`,
    [p.title, p.caption, p.cta, p.hashtags, p.notes, p.category, p.type, campaigns.get(p.campaignSlug) ?? null, p.scheduledAt, config.APP_TIMEZONE, p.key],
  );
  const id = rows[0].id;
  for (const platform of ['facebook', 'instagram']) {
    for (const placement of p.placements) {
      await query(`INSERT INTO content_targets (content_id, platform, placement) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [id, platform, placement]);
    }
  }
  await query(`INSERT INTO approvals (content_id, action, comment, content_version) VALUES ($1, 'imported', $2, 1)`, [id, `Seeded from ${p.campaignSlug}`]);
  return true;
}

export async function seedPlans() {
  const campaigns = new Map<string, string>((await query('SELECT slug, id FROM campaigns')).rows.map((r) => [r.slug, r.id]));
  const time = await postTime();
  let created = 0;
  for (const p of [...octoberPosts(time), ...aimPosts()]) if (await seedPost(p, campaigns)) created++;

  // The AIM 30-day plan was first seeded with dates that clash with the October calendar. Where nobody has
  // touched those posts, turn them back into undated ideas so October shows one post per day.
  const undated = await query(
    `UPDATE content_items SET scheduled_at = NULL, campaign_id = COALESCE($1, campaign_id),
       notes = CASE WHEN notes LIKE 'Idea bank:%' THEN notes ELSE 'Idea bank: AIM 30-day plan. Undated on purpose; give it a date when there is a gap in the calendar.' || E'\\n\\n' || COALESCE(notes, '') END,
       updated_at = now()
     WHERE source_key LIKE 'plan:aim-30:%' AND scheduled_at IS NOT NULL AND NOT locally_modified AND version = 1
       AND approval_status = 'draft' AND publish_status = 'unscheduled'`,
    [campaigns.get('aim-30-day') ?? null],
  );
  if (created || undated.rowCount) console.log(`Plans: seeded ${created} posts; ${undated.rowCount ?? 0} AIM ideas set undated.`);
}
