import { query, type Db } from '../db/pool.js';
import type { SessionUser } from '../../shared/domain.js';

export interface AuditEntry {
  actor: SessionUser | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  contentRef?: string | null;
  previous?: unknown;
  next?: unknown;
  executionId?: string | null;
  result: 'success' | 'failure' | 'denied';
  detail?: string | null;
}

/** Append-only audit trail. Never throws into the caller's request path. */
export async function audit(e: AuditEntry, db?: Db) {
  try {
    await query(
      `INSERT INTO audit_log (actor_id, actor_email, action, entity_type, entity_id, content_ref,
         previous, next, execution_id, result, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        e.actor?.id ?? null,
        e.actor?.email ?? 'system',
        e.action,
        e.entityType,
        e.entityId ?? null,
        e.contentRef ?? null,
        e.previous === undefined ? null : JSON.stringify(e.previous),
        e.next === undefined ? null : JSON.stringify(e.next),
        e.executionId ?? null,
        e.result,
        e.detail ?? null,
      ],
      db,
    );
  } catch (err) {
    console.error('audit write failed', err);
  }
}

/** Keep only the fields that actually changed, for compact previous/new values. */
export function diff<T extends Record<string, unknown>>(before: T, after: Partial<T>) {
  const prev: Record<string, unknown> = {};
  const next: Record<string, unknown> = {};
  for (const k of Object.keys(after)) {
    const a = before[k];
    const b = after[k];
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) {
      prev[k] = a ?? null;
      next[k] = b ?? null;
    }
  }
  return { prev, next, changed: Object.keys(next).length > 0 };
}
