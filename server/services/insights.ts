import { query } from '../db/pool.js';
import { config } from '../config.js';
import { dayKey, zonedToUtc } from '../../shared/time.js';
import { listContent } from './content.js';
import { listConnections } from './connections.js';
import { listVideos } from './library.js';
import { brand } from '../brand.js';

function todayRange(tz: string) {
  const today = dayKey(new Date(), tz);
  const start = zonedToUtc(today, '00:00', tz);
  const end = new Date(start.getTime() + 86_400_000);
  return { today, start: start.toISOString(), end: end.toISOString() };
}

export async function overview() {
  const tz = config.APP_TIMEZONE;
  const { start, end } = todayRange(tz);
  const weekEnd = new Date(new Date(start).getTime() + 7 * 86_400_000).toISOString();
  const monthEnd = new Date(new Date(start).getTime() + 30 * 86_400_000).toISOString();

  const all = (await listContent({}, { pageSize: 5000, sort: 'scheduled_at', dir: 'asc' })).items;
  const active = all.filter((c) => c.publish_status !== 'published');
  const [counts, pubs, runs, videos, connections, activity, campaigns] = await Promise.all([
    query(`SELECT
        count(*) FILTER (WHERE state IN ('scheduled','paused','dispatching')) AS in_queue,
        count(*) FILTER (WHERE state = 'failed') AS failed
      FROM queue_items`),
    query(`SELECT count(*) AS n FROM publications`),
    query(`SELECT count(*) FILTER (WHERE status = 'failed' AND started_at > now() - interval '7 days') AS failed_runs FROM workflow_runs`),
    listVideos({}),
    listConnections(),
    query(`SELECT * FROM audit_log WHERE action NOT LIKE 'auth.%' ORDER BY created_at DESC LIMIT 12`),
    query(`SELECT c.id, c.name, c.target_count, c.slug,
        (SELECT count(*) FROM videos v WHERE v.campaign_id = c.id AND v.archived_at IS NULL) AS videos,
        (SELECT count(*) FROM videos v WHERE v.campaign_id = c.id AND v.youtube_status = 'public') AS videos_public,
        (SELECT count(*) FROM content_items i WHERE i.campaign_id = c.id AND i.archived_at IS NULL) AS items,
        (SELECT count(*) FROM content_items i WHERE i.campaign_id = c.id AND i.publish_status = 'published') AS items_published
      FROM campaigns c WHERE c.status IN ('active','planned') ORDER BY c.created_at`),
  ]);

  const inRange = (iso: string | null, a: string, b: string) => !!iso && iso >= a && iso < b;
  const sched = (c: (typeof all)[number]) => c.scheduled_at;
  const metaReady = active.filter(
    (c) => c.readiness === 'ready' && c.targets.some((t) => t.platform === 'facebook' || t.platform === 'instagram'),
  );
  const nfa = campaigns.rows.find((c) => c.slug === brand.libraryCampaignSlug);
  const pick = (c: (typeof all)[number]) => ({
    id: c.id, ref: c.ref, title: c.title, scheduled_at: c.scheduled_at, category: c.category, priority: c.priority,
    approval_status: c.approval_status, publish_status: c.publish_status, readiness: c.readiness,
    platforms: [...new Set(c.targets.map((t) => t.platform))],
  });

  return {
    timezone: tz,
    kpis: {
      scheduled_today: all.filter((c) => inRange(sched(c), start, end)).length,
      awaiting_approval: all.filter((c) => c.approval_status === 'pending').length,
      needs_revision: all.filter((c) => c.approval_status === 'revision_requested' || c.approval_status === 'rejected').length,
      missing_assets: active.filter((c) => c.issues.some((i) => i.code === 'asset_missing' || i.code === 'asset_unapproved')).length,
      needs_details: active.filter((c) => c.issues.some((i) => i.code === 'needs_details')).length,
      meta_ready: metaReady.length,
      youtube_ready: videos.filter((v) => v.youtube_ready && v.youtube_status === 'not_uploaded').length,
      in_queue: counts.rows[0].in_queue,
      published: pubs.rows[0].n,
      failed: counts.rows[0].failed,
      failed_runs_7d: runs.rows[0].failed_runs,
    },
    today: all.filter((c) => inRange(sched(c), start, end)).map(pick),
    next7: all.filter((c) => inRange(sched(c), start, weekEnd)).map(pick),
    milestones: all
      .filter((c) => (c.category === 'Birthday' || c.category === 'Anniversary') && c.publish_status !== 'published' && (c.priority === 1 || inRange(sched(c), start, monthEnd)))
      .map(pick),
    events: all
      .filter((c) => (c.category === 'Event' || c.category === 'Power Hour' || c.category === 'J.A.M. Session') && inRange(sched(c), start, monthEnd))
      .map(pick),
    nfamation: nfa
      ? {
          name: nfa.name,
          target: nfa.target_count ?? 50,
          videos: nfa.videos,
          public: nfa.videos_public,
          ready: videos.filter((v) => v.youtube_ready).length,
          social_published: nfa.items_published,
          social_total: nfa.items,
        }
      : null,
    campaigns: campaigns.rows,
    connections: connections.map((c) => ({ key: c.key, label: c.label, status: c.status, automation_enabled: c.automation_enabled })),
    activity: activity.rows,
  };
}

export async function analytics(weeks = 12) {
  const tz = config.APP_TIMEZONE;
  const [byPlatform, byCategory, pipeline, weekly, success, campaigns, youtube] = await Promise.all([
    query(`SELECT t.platform, count(DISTINCT c.id) AS n FROM content_targets t JOIN content_items c ON c.id = t.content_id
           WHERE c.archived_at IS NULL GROUP BY t.platform ORDER BY n DESC`),
    query(`SELECT category, count(*) AS n FROM content_items WHERE archived_at IS NULL GROUP BY category ORDER BY n DESC`),
    query(`SELECT approval_status AS status, count(*) AS n FROM content_items WHERE archived_at IS NULL GROUP BY approval_status`),
    query(
      `SELECT to_char(date_trunc('week', p.published_at AT TIME ZONE $1), 'YYYY-MM-DD') AS week, p.platform, count(*) AS n
       FROM publications p WHERE p.published_at > now() - ($2 || ' weeks')::interval GROUP BY 1, 2 ORDER BY 1`,
      [tz, String(weeks)],
    ),
    query(`SELECT
        (SELECT count(*) FROM publications) AS succeeded,
        (SELECT count(*) FROM publications WHERE method = 'automated') AS automated,
        (SELECT count(*) FROM publications WHERE method = 'manual') AS manual,
        (SELECT count(*) FROM queue_items WHERE state = 'failed') AS failed,
        (SELECT count(*) FROM workflow_runs WHERE kind = 'publish' AND status = 'failed') AS failed_attempts`),
    query(`SELECT c.name, c.target_count,
        (SELECT count(*) FROM content_items i WHERE i.campaign_id = c.id AND i.archived_at IS NULL) AS total,
        (SELECT count(*) FROM content_items i WHERE i.campaign_id = c.id AND i.publish_status = 'published') AS published,
        (SELECT count(*) FROM content_items i WHERE i.campaign_id = c.id AND i.approval_status = 'approved' AND i.publish_status <> 'published') AS approved
       FROM campaigns c ORDER BY c.created_at`),
    query(`SELECT youtube_status AS status, count(*) AS n FROM videos WHERE archived_at IS NULL GROUP BY youtube_status`),
  ]);

  // Pivot weekly publications into one row per week.
  const weeksMap = new Map<string, Record<string, number | string>>();
  for (const r of weekly.rows) {
    const row: Record<string, number | string> = weeksMap.get(r.week) ?? { week: r.week };
    row[r.platform] = r.n;
    weeksMap.set(r.week, row);
  }
  return {
    by_platform: byPlatform.rows,
    by_category: byCategory.rows,
    pipeline: pipeline.rows,
    weekly: [...weeksMap.values()],
    success: success.rows[0],
    campaigns: campaigns.rows,
    youtube: youtube.rows,
    // Engagement needs Meta Insights / YouTube Analytics access, which is not connected yet.
    engagement: { available: false, reason: 'Requires Meta Page/Instagram insights permissions and YouTube Analytics access through n8n.' },
  };
}

export async function notifications(role: string) {
  const [pending, failed, conn] = await Promise.all([
    query(`SELECT id, ref, title, updated_at FROM content_items WHERE approval_status = 'pending' AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 10`),
    query(`SELECT q.id, q.last_error, q.updated_at, c.id AS content_id, c.ref, c.title FROM queue_items q JOIN content_items c ON c.id = q.content_id
           WHERE q.state = 'failed' ORDER BY q.updated_at DESC LIMIT 10`),
    query(`SELECT key, label, last_error, last_error_at FROM connections WHERE status = 'disconnected' AND last_error_at > now() - interval '3 days'`),
  ]);
  const items = [
    ...failed.rows.map((r) => ({ kind: 'failure', title: `Publishing failed: ${r.ref}`, body: r.last_error, at: r.updated_at, content_id: r.content_id })),
    ...conn.rows.map((r) => ({ kind: 'connection', title: `${r.label} disconnected`, body: r.last_error, at: r.last_error_at, content_id: null })),
    ...(role === 'approver' || role === 'admin'
      ? pending.rows.map((r) => ({ kind: 'approval', title: `Awaiting approval: ${r.ref}`, body: r.title, at: r.updated_at, content_id: r.id }))
      : []),
  ].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return items.slice(0, 20);
}
