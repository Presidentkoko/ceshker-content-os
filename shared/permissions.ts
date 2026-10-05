import type { Role } from './domain.js';

// Single source of truth for who may do what. The API enforces these; the web
// client uses the same table only to decide which controls to render.
export const PERMISSIONS = {
  'content.view': ['admin', 'content_manager', 'approver', 'viewer'],
  'content.edit': ['admin', 'content_manager'],
  'content.archive': ['admin', 'content_manager'],
  'content.submit': ['admin', 'content_manager'],
  'content.approve': ['admin', 'approver'],
  'content.export': ['admin', 'content_manager', 'approver', 'viewer'],
  'queue.manage': ['admin', 'content_manager'],
  'queue.dry_run': ['admin', 'content_manager'],
  'queue.retry': ['admin', 'content_manager'],
  'video.edit': ['admin', 'content_manager'],
  'campaign.edit': ['admin', 'content_manager'],
  'sheet.sync': ['admin', 'content_manager'],
  'connections.test': ['admin'],
  'connections.automation': ['admin'],
  'users.manage': ['admin'],
  'settings.manage': ['admin'],
  'audit.view': ['admin', 'content_manager', 'approver', 'viewer'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role | undefined | null, permission: Permission): boolean {
  if (!role) return false;
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}
