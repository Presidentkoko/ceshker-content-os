// Reads a Google Drive folder that is shared "anyone with the link", without API credentials.
// Used for the NFAMation library until the Google connection (OAuth / service account) is in place.

export interface PublicDriveEntry {
  id: string;
  name: string;
  kind: 'folder' | 'video' | 'image' | 'other';
  url: string;
  path: string;
}

function decode(s: string) {
  return s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

async function listOne(folderId: string): Promise<{ id: string; name: string; href: string }[]> {
  const res = await fetch(`https://drive.google.com/embeddedfolderview?id=${folderId}`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Drive folder is not shared by link (HTTP ${res.status}).`);
  const html = await res.text();
  const out: { id: string; name: string; href: string }[] = [];
  const re = /<div class="flip-entry" id="entry-([\w-]+)"[\s\S]*?<a href="([^"]+)"[\s\S]*?<div class="flip-entry-title">([^<]*)<\/div>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.push({ id: m[1], href: decode(m[2]), name: decode(m[3]) });
  return out;
}

function kindOf(name: string, href: string): PublicDriveEntry['kind'] {
  if (/\/folders\//.test(href)) return 'folder';
  if (/\.(mp4|mov|m4v|avi|mkv|webm|wmv)$/i.test(name)) return 'video';
  if (/\.(png|jpe?g|gif|webp|heic)$/i.test(name)) return 'image';
  return 'other';
}

export async function listPublicTree(folderId: string, depth = 4, path = ''): Promise<PublicDriveEntry[]> {
  const out: PublicDriveEntry[] = [];
  for (const e of await listOne(folderId)) {
    const kind = kindOf(e.name, e.href);
    const url = kind === 'folder' ? `https://drive.google.com/drive/folders/${e.id}` : `https://drive.google.com/file/d/${e.id}/view`;
    out.push({ id: e.id, name: e.name, kind, url, path });
    if (kind === 'folder' && depth > 0) out.push(...(await listPublicTree(e.id, depth - 1, `${path}${e.name}/`)));
  }
  return out;
}
