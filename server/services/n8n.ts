import crypto from 'node:crypto';
import { config } from '../config.js';

export function n8nConfigured() {
  return !!config.N8N_PUBLISH_WEBHOOK_URL;
}

export interface N8nResult {
  ok: boolean;
  status: number;
  executionId: string | null;
  body: any;
  error: string | null;
}

/**
 * POST a job to the n8n publishing webhook. The body is signed with HMAC-SHA256
 * so the n8n workflow can reject anything that did not come from the dashboard.
 * No credentials are ever sent; n8n holds the platform credentials itself.
 */
export async function callN8n(payload: Record<string, unknown>, timeoutMs = 20_000): Promise<N8nResult> {
  if (!config.N8N_PUBLISH_WEBHOOK_URL) {
    return { ok: false, status: 0, executionId: null, body: null, error: 'N8N_PUBLISH_WEBHOOK_URL is not configured.' };
  }
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.N8N_WEBHOOK_SECRET) {
    headers['x-contentos-signature'] = crypto.createHmac('sha256', config.N8N_WEBHOOK_SECRET).update(body).digest('hex');
  }
  if (typeof payload.idempotency_key === 'string') headers['idempotency-key'] = payload.idempotency_key;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(config.N8N_PUBLISH_WEBHOOK_URL, { method: 'POST', headers, body, signal: ctrl.signal });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text.slice(0, 2000) };
    }
    const executionId = json?.execution_id ?? json?.executionId ?? res.headers.get('x-n8n-execution-id') ?? null;
    const ok = res.ok && json?.ok !== false;
    return {
      ok,
      status: res.status,
      executionId: executionId ? String(executionId) : null,
      body: json,
      error: ok ? null : json?.error ?? `n8n responded with HTTP ${res.status}`,
    };
  } catch (e) {
    const msg = (e as Error).name === 'AbortError' ? `n8n did not respond within ${timeoutMs / 1000}s` : (e as Error).message;
    return { ok: false, status: 0, executionId: null, body: null, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

export async function n8nHealth(): Promise<{ ok: boolean; error: string | null }> {
  if (!config.N8N_BASE_URL) return { ok: false, error: 'N8N_BASE_URL is not configured.' };
  try {
    const res = await fetch(new URL('/healthz', config.N8N_BASE_URL), { signal: AbortSignal.timeout(8000) });
    return res.ok ? { ok: true, error: null } : { ok: false, error: `Health check returned HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
