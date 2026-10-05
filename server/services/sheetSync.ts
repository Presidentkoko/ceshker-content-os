import { brand } from '../brand.js';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import { config } from '../config.js';
import { query, tx } from '../db/pool.js';
import type { SessionUser } from '../../shared/domain.js';
import { zonedToUtc } from '../../shared/time.js';
import { audit } from './audit.js';
import { refreshPublishStatus } from './content.js';
import { serviceAccount, sheetHyperlinks } from './google.js';

export const sheetCsvUrl = () =>
  `https://docs.google.com/spreadsheets/d/${config.GOOGLE_SHEET_ID}/export?format=csv&gid=${config.GOOGLE_SHEET_GID}`;
const sheetCellUrl = (row: number, col = 'D') =>
  `https://docs.google.com/spreadsheets/d/${config.GOOGLE_SHEET_ID}/edit#gid=${config.GOOGLE_SHEET_GID}&range=${col}${row + 1}`;

const COL = { date: 0, title: 2, graphics: 3, caption: 4, hashtags: 6, note: 7, status: 8, posted: 9, facebook: 10, instagram: 11 };
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export interface SheetRecord {
  sourceKey: string;
  hash: string;
  row: number;
  title: string;
  caption: string | null;
  hashtags: string | null;
  notes: string | null;
  category: string;
  priority: number | null;
  contentType: string;
  scheduledAt: string | null;
  approval: 'draft' | 'pending' | 'approved';
  posted: boolean;
  targets: { platform: 'facebook' | 'instagram'; placement: string }[];
  assetNeeded: boolean;
  assets: { kind: 'image' | 'video' | 'link'; label: string; url: string; driveLinked: boolean }[];
  campaignSlug: string | null;
  seriesNo: number | null;
}

const clean = (s: string | undefined) => (s ?? '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim();

export function parseSheetDate(raw: string, tz: string): string | null {
  const m = raw.match(/([A-Za-z]+)\s*(\d{1,2})\s*,?\s*(\d{4})/);
  if (!m) return null;
  const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
  if (mi < 0) return null;
  const time = /\bPM\b/i.test(raw) ? '15:00' : /\bAM\b/i.test(raw) ? '09:00' : '10:00';
  const date = `${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return zonedToUtc(date, time, tz).toISOString();
}

export function categorize(title: string): { category: string; campaignSlug: string | null } {
  const t = title.toLowerCase();
  if (brand.key === 'aim') {
    if (/recap|highlights|thanks for coming/.test(t)) return { category: 'Meetup Recap', campaignSlug: null };
    if (/\baim\b|meetup/.test(t)) return { category: 'AIM Meetup', campaignSlug: null };
    if (/speaker|interview|guest/.test(t)) return { category: 'Speaker', campaignSlug: 'aim-library' };
    if (/spotlight|member/.test(t)) return { category: 'Member Spotlight', campaignSlug: null };
    if (/\bsold\b|closing|closed/.test(t)) return { category: 'Sold', campaignSlug: 'dsr-listings' };
    if (/listing|for sale|flyer/.test(t)) return { category: 'Listing', campaignSlug: 'dsr-listings' };
    if (/testimonial|review/.test(t)) return { category: 'Testimonial', campaignSlug: null };
    if (/recruit|agent|join (the )?team|brokerage/.test(t)) return { category: 'Agent Recruiting', campaignSlug: 'dsr-recruiting' };
    if (/poll|question|engagement/.test(t)) return { category: 'Engagement', campaignSlug: null };
    if (/holiday|memorial day|4th of july|thanksgiving|christmas/.test(t)) return { category: 'Holiday', campaignSlug: null };
    if (/\bevent\b/.test(t)) return { category: 'Event', campaignSlug: null };
    if (/\btips?\b|how to|mistake|why |strategy/.test(t)) return { category: 'Education', campaignSlug: null };
    return { category: 'General', campaignSlug: null };
  }
  if (/\bnf?a?mation|\bnfmation/.test(t)) return { category: 'NFAMation', campaignSlug: 'nfamation-library' };
  if (/j\.?\s?a\.?\s?m\.?\s*session|j\.a\.m/.test(t)) return { category: 'J.A.M. Session', campaignSlug: 'jam-sessions' };
  if (/birthday/.test(t)) return { category: 'Birthday', campaignSlug: null };
  if (/anniversary/.test(t)) return { category: 'Anniversary', campaignSlug: null };
  if (/power hour/.test(t)) return { category: 'Power Hour', campaignSlug: 'power-hour' };
  if (/black sheep|convention/.test(t)) return { category: 'Event', campaignSlug: 'black-sheep-2026' };
  if (/\bevent\b/.test(t)) return { category: 'Event', campaignSlug: null };
  if (/testimonial/.test(t)) return { category: 'Testimonial', campaignSlug: null };
  if (/closing safety|wiring|\btip\b|wrap basics|mv realty/.test(t)) return { category: 'Education', campaignSlug: null };
  if (/closing|client-/.test(t)) return { category: 'Closing', campaignSlug: null };
  if (/seller-financed|potential deal|property/.test(t)) return { category: 'Property', campaignSlug: null };
  if (/poll|community question/.test(t)) return { category: 'Poll', campaignSlug: null };
  if (/^day \d+:|ultra/.test(t)) return { category: 'ULTRA', campaignSlug: 'ultra-launch' };
  if (/hiring/.test(t)) return { category: 'Hiring', campaignSlug: null };
  if (/holiday|memorial day|4th of july/.test(t)) return { category: 'Holiday', campaignSlug: null };
  return { category: 'General', campaignSlug: null };
}

function placementsFrom(raw: string, isReel: boolean): string[] {
  const out = new Set<string>();
  for (const part of raw.toLowerCase().split(/[,/]/).map((s) => s.trim())) {
    if (part === 'story') out.add('story');
    else if (part === 'post' || part === 'feed') out.add(isReel ? 'reel' : 'feed');
    else if (part === 'reel') out.add('reel');
  }
  return [...out];
}

export function parseSheet(csv: string, links: Map<string, string> = new Map(), tz = config.APP_TIMEZONE): SheetRecord[] {
  const rows: string[][] = parse(csv, { relax_column_count: true, bom: true });
  const records: SheetRecord[] = [];
  const seen = new Map<string, number>();
  let current: SheetRecord | null = null;

  for (let i = 3; i < rows.length; i++) {
    const r = rows[i];
    const title = clean(r[COL.title]);
    if (!title) {
      // Continuation row: carries asset links for the record above it.
      const label = clean(r[COL.graphics]);
      if (current && label && !/add approved asset/i.test(label)) {
        const link = links.get(`${i}:${COL.graphics}`);
        const isVideo = /video/i.test(label);
        current.assets.push({
          kind: link ? (isVideo ? 'video' : 'image') : 'link',
          label: link ? label : `${label} (link in planning sheet)`,
          url: link ?? sheetCellUrl(i),
          driveLinked: !!link,
        });
      }
      continue;
    }
    const rawDate = clean(r[COL.date]);
    const scheduledAt = parseSheetDate(rawDate, tz);
    const { category, campaignSlug } = categorize(title);
    const lower = title.toLowerCase();
    const isReel = /\breel\b/.test(lower);
    const contentType = isReel ? 'reel' : /\bstory\b/.test(lower) ? 'story' : /carousel/.test(lower) ? 'carousel' : 'post';
    const notes = clean(r[COL.note]) || null;
    const pr = notes?.match(/PRIORITY\s*(\d)/i);
    const status = clean(r[COL.status]).toLowerCase();
    const approval = status === 'for approval' ? 'pending' : /approved|ready for posting|scheduled for posting/.test(status) ? 'approved' : 'draft';
    const targets: SheetRecord['targets'] = [];
    for (const p of placementsFrom(clean(r[COL.facebook]), isReel)) targets.push({ platform: 'facebook', placement: p });
    for (const p of placementsFrom(clean(r[COL.instagram]), isReel)) targets.push({ platform: 'instagram', placement: p });
    let caption = (r[COL.caption] ?? '').replace(/\r/g, '').trim();
    caption = caption.replace(/^CAPTION:\s*/i, '');
    const seriesMatch = category === 'NFAMation' ? title.match(/#\s*(\d+)/) : null;

    const baseKey = `${scheduledAt?.slice(0, 10) ?? 'undated'}|${lower.replace(/\s+/g, ' ')}`;
    const n = (seen.get(baseKey) ?? 0) + 1;
    seen.set(baseKey, n);
    const sourceKey = 'sheet:' + crypto.createHash('sha1').update(`${baseKey}|${n}`).digest('hex').slice(0, 16);

    current = {
      sourceKey,
      hash: '',
      row: i + 1,
      title: title.replace(/\s*\n\s*/g, ' '),
      caption: caption || null,
      hashtags: clean(r[COL.hashtags]) || null,
      notes,
      category,
      priority: pr ? Number(pr[1]) : null,
      contentType,
      scheduledAt,
      approval,
      posted: clean(r[COL.posted]).toUpperCase() === 'TRUE',
      targets,
      assetNeeded: /asset needed/i.test(clean(r[COL.graphics])),
      assets: [],
      campaignSlug,
      seriesNo: seriesMatch ? Number(seriesMatch[1]) : null,
    };
    const ownLink = links.get(`${i}:${COL.graphics}`);
    if (ownLink) current.assets.push({ kind: 'image', label: clean(r[COL.graphics]) || 'Graphic', url: ownLink, driveLinked: true });
    records.push(current);
  }
  for (const rec of records) {
    const { hash: _h, row: _r, ...rest } = rec;
    rec.hash = crypto.createHash('sha1').update(JSON.stringify(rest)).digest('hex');
  }
  return records;
}

export async function fetchSheet(): Promise<{ records: SheetRecord[]; linksImported: SyncSummary['linksImported'] }> {
  if (!config.GOOGLE_SHEET_ID) throw new Error('GOOGLE_SHEET_ID is not configured.');
  const res = await fetch(sheetCsvUrl(), { signal: AbortSignal.timeout(30_000) });
  const csv = await res.text();
  if (!res.ok || csv.trimStart().startsWith('<')) {
    throw new Error(`Could not read the planning sheet (HTTP ${res.status}). Check that it is viewable by link.`);
  }
  let links = new Map<string, string>();
  let linksImported: SyncSummary['linksImported'] = false;
  if (serviceAccount()) {
    try {
      links = await sheetHyperlinks(config.GOOGLE_SHEET_ID, config.GOOGLE_SHEET_GID);
      linksImported = 'live';
    } catch (e) {
      console.warn('Sheet hyperlink import skipped:', (e as Error).message);
    }
  }
  if (!linksImported) {
    // Without API access the CSV has no hyperlinks; fall back to the snapshot taken
    // from the sheet's .xlsx export (data/sheet_links.json), matched by row and column.
    const snap = await loadLinkSnapshot();
    if (snap.size) {
      links = snap;
      linksImported = 'snapshot';
    }
  }
  return { records: parseSheet(csv, links), linksImported };
}

async function loadLinkSnapshot(): Promise<Map<string, string>> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const p of [path.resolve(here, '../../data/sheet_links.json'), path.resolve(here, '../../../data/sheet_links.json')]) {
    try {
      return new Map(Object.entries(JSON.parse(await readFile(p, 'utf8'))));
    } catch {}
  }
  return new Map();
}

export interface SyncSummary {
  created: number;
  updated: number;
  unchanged: number;
  skippedLocalEdits: string[];
  publicationsRecorded: number;
  linksImported: false | 'live' | 'snapshot';
  total: number;
}

/**
 * Import the planning sheet. The sheet is a planning source, not the system of
 * record: rows edited in the dashboard are never overwritten, only reported.
 */
export async function syncSheet(user: SessionUser | null): Promise<SyncSummary> {
  const { rows: run } = await query(
    `INSERT INTO workflow_runs (kind, summary, triggered_by) VALUES ('sheet_sync', 'Import planning sheet', $1) RETURNING id`,
    [user?.id ?? null],
  );
  try {
    const { records, linksImported } = await fetchSheet();
    const summary: SyncSummary = { created: 0, updated: 0, unchanged: 0, skippedLocalEdits: [], publicationsRecorded: 0, linksImported, total: records.length };
    const campaigns = new Map((await query('SELECT id, slug FROM campaigns')).rows.map((c) => [c.slug, c.id]));

    for (const rec of records) {
      await tx(async (client) => {
        const existing = (await client.query('SELECT id, ref, source_hash, locally_modified FROM content_items WHERE source_key = $1 FOR UPDATE', [rec.sourceKey])).rows[0];
        if (existing?.locally_modified) {
          summary.skippedLocalEdits.push(existing.ref);
          return;
        }
        if (existing && existing.source_hash === rec.hash) {
          summary.unchanged++;
          return;
        }
        let videoId: string | null = null;
        if (rec.seriesNo) {
          const v = await client.query(
            `INSERT INTO videos (source_key, title, series_no, campaign_id)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (source_key) DO UPDATE SET updated_at = now() RETURNING id`,
            [`nfamation-${rec.seriesNo}`, rec.title.replace(/^nf?a?mation[^#]*#\s*\d+\s*/i, '').trim() || rec.title, rec.seriesNo, campaigns.get('nfamation-library') ?? null],
          );
          videoId = v.rows[0].id;
        }
        const values = [
          rec.title, rec.caption, rec.hashtags, rec.notes, rec.category, rec.priority, rec.contentType,
          rec.campaignSlug ? campaigns.get(rec.campaignSlug) ?? null : null, rec.scheduledAt, config.APP_TIMEZONE,
          rec.approval, rec.hash, videoId,
        ];
        let id: string;
        let ref: string;
        if (existing) {
          id = existing.id;
          ref = existing.ref;
          await client.query(
            `UPDATE content_items SET title=$2, caption=$3, hashtags=$4, notes=$5, category=$6, priority=$7, content_type=$8,
               campaign_id=$9, scheduled_at=$10, timezone=$11, approval_status=$12, source_hash=$13, video_id=$14,
               synced_at=now(), updated_at=now(), version=version+1
             WHERE id=$1`,
            [id, ...values],
          );
          await client.query(`DELETE FROM assets WHERE content_id = $1 AND created_by IS NULL`, [id]);
          summary.updated++;
        } else {
          const ins = await client.query(
            `INSERT INTO content_items (title, caption, hashtags, notes, category, priority, content_type, campaign_id,
               scheduled_at, timezone, approval_status, source_hash, video_id, source, source_key, synced_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'sheet',$14, now()) RETURNING id, ref`,
            [...values, rec.sourceKey],
          );
          id = ins.rows[0].id;
          ref = ins.rows[0].ref;
          await client.query(
            `INSERT INTO approvals (content_id, action, comment, content_version) VALUES ($1, 'imported', $2, 1)`,
            [id, `Imported from planning sheet row ${rec.row} with status "${rec.approval}"`],
          );
          summary.created++;
        }
        // Targets: add what the sheet lists; keep any that already have publications.
        for (const t of rec.targets) {
          await client.query(`INSERT INTO content_targets (content_id, platform, placement) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [id, t.platform, t.placement]);
        }
        await client.query(
          `DELETE FROM content_targets t WHERE t.content_id = $1 AND NOT (t.platform || ':' || t.placement = ANY($2))
             AND NOT EXISTS (SELECT 1 FROM publications p WHERE p.target_id = t.id)
             AND NOT EXISTS (SELECT 1 FROM queue_items q WHERE q.target_id = t.id AND q.state IN ('scheduled','paused','dispatching'))`,
          [id, rec.targets.map((t) => `${t.platform}:${t.placement}`)],
        );
        for (const a of rec.assets) {
          // Sheet-sourced assets (created_by NULL). Graphics on approved rows were approved in the sheet workflow.
          await client.query(
            `INSERT INTO assets (content_id, kind, url, drive_file_id, label, approved) VALUES ($1,$2,$3,$4,$5,$6)`,
            [id, a.kind, a.url, a.driveLinked ? a.url.match(/\/d\/([\w-]{10,})/)?.[1] ?? null : null, a.label, a.driveLinked && rec.approval === 'approved'],
          );
        }
        if (rec.posted) {
          const r = await client.query(
            `INSERT INTO publications (content_id, target_id, platform, method, published_at)
             SELECT $1, t.id, t.platform, 'manual', COALESCE($2::timestamptz, now()) FROM content_targets t
             WHERE t.content_id = $1 ON CONFLICT (target_id) DO NOTHING`,
            [id, rec.scheduledAt],
          );
          summary.publicationsRecorded += r.rowCount ?? 0;
        }
        await refreshPublishStatus(client, id);
        void ref;
      });
    }
    await query(`UPDATE workflow_runs SET status='succeeded', finished_at=now(), response=$2 WHERE id=$1`, [run[0].id, JSON.stringify(summary)]);
    await query(`UPDATE connections SET status='connected', last_success_at=now(), last_checked_at=now() WHERE key='google_sheets'`);
    await audit({ actor: user, action: 'sheet.sync', entityType: 'sheet', entityId: config.GOOGLE_SHEET_ID, next: summary, result: 'success', executionId: run[0].id });
    return summary;
  } catch (e) {
    const msg = (e as Error).message;
    await query(`UPDATE workflow_runs SET status='failed', finished_at=now(), error=$2 WHERE id=$1`, [run[0].id, msg]);
    await query(`UPDATE connections SET status='disconnected', last_error=$1, last_error_at=now(), last_checked_at=now() WHERE key='google_sheets'`, [msg]);
    await audit({ actor: user, action: 'sheet.sync', entityType: 'sheet', entityId: config.GOOGLE_SHEET_ID ?? null, result: 'failure', detail: msg, executionId: run[0].id });
    throw e;
  }
}
