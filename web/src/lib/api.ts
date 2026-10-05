export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: any,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${url}`, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/auth/')) window.dispatchEvent(new Event('cos:unauthorized'));
    throw new ApiError(res.status, json?.error ?? `Request failed (${res.status})`, json?.details);
  }
  return json as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body: unknown = {}) => request<T>('POST', url, body),
  patch: <T>(url: string, body: unknown) => request<T>('PATCH', url, body),
  put: <T>(url: string, body: unknown) => request<T>('PUT', url, body),
  del: <T>(url: string) => request<T>('DELETE', url),
};

export function qs(params: Record<string, unknown>) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}

/** Human message for an API error, including field-level validation detail. */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    const fields = e.details?.fields as { path: string; message: string }[] | undefined;
    const issues = e.details?.issues as { message: string }[] | undefined;
    if (fields?.length) return `${e.message} ${fields.map((f) => `${f.path}: ${f.message}`).join('; ')}`;
    if (issues?.length) return `${e.message} ${issues.map((i) => i.message).join(' ')}`;
    return e.message;
  }
  return (e as Error)?.message ?? 'Unexpected error';
}
