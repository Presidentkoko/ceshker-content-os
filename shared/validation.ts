import type { ApprovalStatus, Platform, Readiness, ValidationIssue } from './domain.js';
import { PLATFORM_LABELS } from './domain.js';

export interface ValidationInput {
  title: string;
  caption: string | null;
  cta?: string | null;
  description: string | null;
  hashtags: string | null;
  scheduled_at: string | null;
  approval_status: ApprovalStatus;
  archived_at: string | null;
  targets: { platform: Platform; placement: string }[];
  assets: { kind: string; approved: boolean }[];
}

export interface ConnectionState {
  /** platform -> connection is live and an administrator has enabled automation */
  [platform: string]: { connected: boolean; automationEnabled: boolean } | undefined;
}

const IG_CAPTION_MAX = 2200;
const IG_HASHTAG_MAX = 30;
const FB_CAPTION_MAX = 63206;
const YT_TITLE_MAX = 100;
const YT_DESCRIPTION_MAX = 5000;

function hashtagCount(caption: string | null, hashtags: string | null): number {
  const text = `${caption ?? ''} ${hashtags ?? ''}`;
  return (text.match(/#[\p{L}\p{N}_]+/gu) ?? []).length;
}

/** Square-bracket placeholders such as [DATE], [VENUE] or [Real attendee quote] that still need real details. */
export function findPlaceholders(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/\[([^\[\]\n]{1,60})\]/g)) {
    const inner = m[1].trim();
    if (/^\d+$/.test(inner) || /^#\s*$/.test(inner)) { found.add('[#]'); continue; }
    if (/^[a-z]$/i.test(inner)) continue; // "[a]" style footnote markers are not placeholders
    found.add(`[${inner}]`);
  }
  return [...found];
}

/**
 * Content-level checks. These decide whether a record could be queued at all;
 * they do not consider platform connections (see publishBlockers).
 */
export function validateContent(input: ValidationInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const err = (code: string, message: string, platform?: Platform) =>
    issues.push({ code, severity: 'error', message, platform });
  const warn = (code: string, message: string, platform?: Platform) =>
    issues.push({ code, severity: 'warning', message, platform });

  if (!input.title.trim()) err('title_missing', 'Title is required.');
  const placeholders = findPlaceholders(`${input.title} ${input.caption ?? ''} ${input.cta ?? ''}`);
  if (placeholders.length) err('needs_details', `Fill in ${placeholders.join(', ')} before this can be approved.`);
  if (input.archived_at) err('archived', 'Archived records cannot be published.');
  if (input.targets.length === 0) err('no_destination', 'Select at least one destination.');
  if (!input.scheduled_at) err('schedule_missing', 'Set a publication date and time.');
  if (input.approval_status !== 'approved') err('not_approved', 'Content must be approved before it can be queued.');

  const approvedMedia = input.assets.filter((a) => a.approved && (a.kind === 'image' || a.kind === 'video'));
  const anyMedia = input.assets.filter((a) => a.kind === 'image' || a.kind === 'video');
  const caption = input.caption?.trim() ?? '';
  const platforms = new Set(input.targets.map((t) => t.platform));

  for (const p of platforms) {
    const label = PLATFORM_LABELS[p];
    if (p === 'facebook' || p === 'instagram' || p === 'linkedin' || p === 'tiktok') {
      if (!caption) err('caption_missing', `${label} needs a caption.`, p);
    }
    if (p === 'instagram' || p === 'youtube' || p === 'tiktok') {
      if (anyMedia.length === 0) err('asset_missing', `${label} requires an image or video asset.`, p);
      else if (approvedMedia.length === 0) err('asset_unapproved', `${label} asset has not been marked approved.`, p);
    }
    if (p === 'facebook' && anyMedia.length > 0 && approvedMedia.length === 0) {
      err('asset_unapproved', 'Facebook asset has not been marked approved.', p);
    }
    if (p === 'facebook' && anyMedia.length === 0) {
      warn('asset_recommended', 'Facebook post has no image or video; it will publish as text only.', p);
    }
    if (p === 'instagram' && caption.length > IG_CAPTION_MAX) {
      err('caption_too_long', `Instagram captions are limited to ${IG_CAPTION_MAX} characters (currently ${caption.length}).`, p);
    }
    if (p === 'instagram' && hashtagCount(input.caption, input.hashtags) > IG_HASHTAG_MAX) {
      err('too_many_hashtags', `Instagram allows at most ${IG_HASHTAG_MAX} hashtags.`, p);
    }
    if (p === 'facebook' && caption.length > FB_CAPTION_MAX) {
      err('caption_too_long', 'Facebook caption exceeds the platform limit.', p);
    }
    if (p === 'youtube') {
      if (input.title.length > YT_TITLE_MAX) err('yt_title_too_long', `YouTube titles are limited to ${YT_TITLE_MAX} characters.`, p);
      const desc = input.description?.trim() || caption;
      if (!desc) err('yt_description_missing', 'YouTube needs a description.', p);
      else if (desc.length > YT_DESCRIPTION_MAX) err('yt_description_too_long', 'YouTube description exceeds 5,000 characters.', p);
      if (!input.assets.some((a) => a.kind === 'thumbnail')) warn('yt_thumbnail_missing', 'No custom thumbnail attached.', p);
      if (/^\s*(video|reel)\s*#?\d+/i.test(input.title)) {
        warn('yt_numbered_title', 'Lead the title with the question or subject, not a video number.', p);
      }
    }
  }

  const hasVideo = input.assets.some((a) => a.kind === 'video');
  const hasImage = input.assets.some((a) => a.kind === 'image');
  for (const t of input.targets) {
    if (t.placement === 'reel' && (t.platform === 'facebook' || t.platform === 'instagram') && !hasVideo) {
      err('reel_needs_video', `${PLATFORM_LABELS[t.platform]} Reels need a video asset.`, t.platform);
    }
    if (t.placement === 'story' && t.platform === 'facebook' && !hasImage) {
      err('fb_story_needs_image', 'Facebook Stories published from the dashboard need an image asset.', t.platform);
    }
  }

  if (input.scheduled_at && new Date(input.scheduled_at).getTime() < Date.now() - 60_000) {
    warn('schedule_in_past', 'Scheduled time is in the past.');
  }
  return issues;
}

export function readinessOf(issues: ValidationIssue[]): Readiness {
  if (issues.some((i) => i.severity === 'error')) {
    // Approval alone is a normal pipeline stage, not a defect.
    const onlyApproval = issues.filter((i) => i.severity === 'error').every((i) => i.code === 'not_approved');
    return onlyApproval ? 'needs_attention' : 'blocked';
  }
  return issues.length ? 'needs_attention' : 'ready';
}

/** Additional blockers that apply to a live publish, beyond content validation. */
export function publishBlockers(
  targets: { platform: Platform }[],
  connections: ConnectionState,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const p of new Set(targets.map((t) => t.platform))) {
    const c = connections[p];
    const label = PLATFORM_LABELS[p];
    if (!c || !c.connected) {
      issues.push({ code: 'connection_missing', severity: 'error', platform: p, message: `${label} is not connected.` });
    } else if (!c.automationEnabled) {
      issues.push({
        code: 'automation_disabled',
        severity: 'error',
        platform: p,
        message: `${label} automation has not been enabled by an administrator.`,
      });
    }
  }
  return issues;
}
