import crypto from 'node:crypto';
import { config } from '../config.js';

// Minimal Google service-account client (JWT bearer flow) so the dashboard can
// read Drive folders and Sheets without a heavy SDK. Scopes are read-only.

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

let cached: { token: string; exp: number } | null = null;

export function serviceAccount(): ServiceAccount | null {
  if (!config.GOOGLE_SERVICE_ACCOUNT_JSON) return null;
  try {
    const raw = config.GOOGLE_SERVICE_ACCOUNT_JSON.trim();
    const json = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
    if (!json.client_email || !json.private_key) return null;
    return json;
  } catch {
    return null;
  }
}

export function serviceAccountEmail() {
  return serviceAccount()?.client_email ?? null;
}

async function accessToken(): Promise<string> {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const sa = serviceAccount();
  if (!sa) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not configured or invalid.');
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`;
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
  });
  const json: any = await res.json();
  if (!res.ok) throw new Error(`Google token exchange failed: ${json.error_description ?? json.error ?? res.status}`);
  cached = { token: json.access_token, exp: Date.now() + json.expires_in * 1000 };
  return cached.token;
}

/** Drive API access is via the service account only (the YouTube connection carries no Drive scope). */
async function bearer(): Promise<string> {
  return accessToken();
}
export const driveApiToken = bearer;

async function gget(url: string) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${await bearer()}` } });
  const json: any = await res.json();
  if (!res.ok) throw new Error(json?.error?.message ?? `Google API HTTP ${res.status}`);
  return json;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  thumbnailLink?: string;
  webViewLink?: string;
  videoMediaMetadata?: { durationMillis?: string };
  parents?: string[];
  path: string;
}

/** Recursively list a folder (videos may sit in sub-folders next to their thumbnails). */
export async function listDriveTree(folderId: string, depth = 3, path = ''): Promise<DriveFile[]> {
  const out: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
    const fields = encodeURIComponent('nextPageToken, files(id,name,mimeType,thumbnailLink,webViewLink,videoMediaMetadata,parents)');
    const json = await gget(
      `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true${pageToken ? `&pageToken=${pageToken}` : ''}`,
    );
    for (const f of json.files as DriveFile[]) {
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        if (depth > 0) out.push(...(await listDriveTree(f.id, depth - 1, `${path}${f.name}/`)));
      } else out.push({ ...f, path });
    }
    pageToken = json.nextPageToken;
  } while (pageToken);
  return out;
}

export async function driveFolderProbe(folderId: string) {
  const json = await gget(`https://www.googleapis.com/drive/v3/files/${folderId}?fields=id,name&supportsAllDrives=true`);
  return json as { id: string; name: string };
}

/** Hyperlinks per row/column from the Sheets API (the CSV export drops them). */
export async function sheetHyperlinks(sheetId: string, gid: string): Promise<Map<string, string>> {
  const meta = await gget(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties`);
  const sheet = meta.sheets.find((s: any) => String(s.properties.sheetId) === gid) ?? meta.sheets[0];
  const title = encodeURIComponent(sheet.properties.title);
  const json = await gget(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?ranges=${title}&fields=sheets.data.rowData.values(hyperlink,textFormatRuns.format.link)`,
  );
  const links = new Map<string, string>();
  const rows = json.sheets?.[0]?.data?.[0]?.rowData ?? [];
  rows.forEach((r: any, ri: number) =>
    (r.values ?? []).forEach((v: any, ci: number) => {
      const link = v.hyperlink ?? v.textFormatRuns?.find((t: any) => t.format?.link?.uri)?.format.link.uri;
      if (link) links.set(`${ri}:${ci}`, link);
    }),
  );
  return links;
}
