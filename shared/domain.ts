// Domain vocabulary shared by the API and the web client.

export const ROLES = ['admin', 'content_manager', 'approver', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Administrator',
  content_manager: 'Content manager',
  approver: 'Approver',
  viewer: 'Viewer',
};

export const PLATFORMS = ['facebook', 'instagram', 'youtube', 'email', 'linkedin', 'tiktok'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_LABELS: Record<Platform, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  youtube: 'YouTube',
  email: 'Email',
  linkedin: 'LinkedIn',
  tiktok: 'TikTok',
};

export const PLACEMENTS = ['feed', 'story', 'reel', 'short', 'video', 'newsletter', 'post'] as const;
export type Placement = (typeof PLACEMENTS)[number];

export const PLATFORM_PLACEMENTS: Record<Platform, Placement[]> = {
  facebook: ['feed', 'story', 'reel'],
  instagram: ['feed', 'story', 'reel'],
  youtube: ['video', 'short'],
  email: ['newsletter'],
  linkedin: ['post'],
  tiktok: ['video'],
};

/** Connection key that must be live before a platform can be published automatically. */
export const PLATFORM_CONNECTION: Record<Platform, string | null> = {
  facebook: 'facebook',
  instagram: 'instagram',
  youtube: 'youtube',
  email: null,
  linkedin: null,
  tiktok: null,
};

export const CONTENT_TYPES = ['post', 'story', 'reel', 'carousel', 'video', 'short', 'email', 'event'] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

export const CATEGORIES = [
  'NFAMation',
  'J.A.M. Session',
  'Event',
  'Power Hour',
  'Birthday',
  'Anniversary',
  'Testimonial',
  'Closing',
  'Property',
  'Poll',
  'ULTRA',
  'Education',
  'Hiring',
  'Holiday',
  'General',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const APPROVAL_STATUSES = ['draft', 'pending', 'approved', 'rejected', 'revision_requested'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const APPROVAL_LABELS: Record<ApprovalStatus, string> = {
  draft: 'Draft',
  pending: 'Awaiting approval',
  approved: 'Approved',
  rejected: 'Rejected',
  revision_requested: 'Needs revision',
};

export const PUBLISH_STATUSES = [
  'unscheduled',
  'queued',
  'paused',
  'publishing',
  'published',
  'partially_published',
  'failed',
] as const;
export type PublishStatus = (typeof PUBLISH_STATUSES)[number];

export const PUBLISH_LABELS: Record<PublishStatus, string> = {
  unscheduled: 'Not queued',
  queued: 'Queued',
  paused: 'Paused',
  publishing: 'Publishing',
  published: 'Published',
  partially_published: 'Partly published',
  failed: 'Failed',
};

export const QUEUE_STATES = ['scheduled', 'paused', 'dispatching', 'published', 'failed', 'cancelled'] as const;
export type QueueState = (typeof QUEUE_STATES)[number];

export const YOUTUBE_STATUSES = ['not_uploaded', 'uploaded_private', 'scheduled', 'public'] as const;
export type YoutubeStatus = (typeof YOUTUBE_STATUSES)[number];

export const YOUTUBE_LABELS: Record<YoutubeStatus, string> = {
  not_uploaded: 'Not uploaded',
  uploaded_private: 'Uploaded (private)',
  scheduled: 'Scheduled',
  public: 'Public',
};

export const PLAYLISTS = [
  'Mortgage Wraps',
  'Subject-To and Assumptions',
  'Seller Financing',
  'Novations and Investor Structures',
  'Title and Closing Problems',
  'Real Investor Questions',
] as const;

export const CONNECTION_KEYS = [
  'google_drive',
  'google_sheets',
  'youtube',
  'facebook',
  'instagram',
  'canva',
  'n8n',
  'postgres',
  'railway',
] as const;
export type ConnectionKey = (typeof CONNECTION_KEYS)[number];

export type Readiness = 'ready' | 'needs_attention' | 'blocked';

export interface ValidationIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  platform?: Platform;
}

export interface ContentTarget {
  id: string;
  platform: Platform;
  placement: Placement;
  /** Facebook Page id or Instagram user id; null = the default Page. */
  account_id?: string | null;
}

export interface Asset {
  id: string;
  kind: 'image' | 'video' | 'thumbnail' | 'document' | 'link';
  url: string;
  label: string | null;
  approved: boolean;
  drive_file_id: string | null;
  created_at: string;
}

export interface ContentItem {
  id: string;
  ref: string;
  source: 'sheet' | 'dashboard';
  locally_modified: boolean;
  title: string;
  caption: string | null;
  description: string | null;
  cta: string | null;
  hashtags: string | null;
  notes: string | null;
  category: string;
  priority: number | null;
  content_type: ContentType;
  campaign_id: string | null;
  campaign_name: string | null;
  video_id: string | null;
  parent_id: string | null;
  scheduled_at: string | null;
  timezone: string;
  approval_status: ApprovalStatus;
  publish_status: PublishStatus;
  version: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  targets: ContentTarget[];
  asset_count: number;
  approved_asset_count: number;
  readiness: Readiness;
  issues: ValidationIssue[];
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}
