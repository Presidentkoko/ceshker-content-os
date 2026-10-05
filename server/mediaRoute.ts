import { Router } from 'express';
import sharp from 'sharp';
import { Readable } from 'node:stream';
import { query } from './db/pool.js';
import { verifyMediaSignature } from './services/meta.js';
import { openDriveFile } from './services/youtube.js';

/**
 * Serves an attached asset to Meta's servers, which fetch media by URL. Every link is HMAC-signed
 * and expires (see signedMediaUrl), so only assets the dashboard chose to publish are reachable.
 */
export const media = Router();

async function openAsset(a: { url: string; drive_file_id: string | null; data: Buffer | null; mime: string | null }) {
  // Stored copy (imported media) takes priority: its original link may have expired.
  if (a.data) return { body: new Blob([a.data]).stream(), size: String(a.data.length), mime: a.mime ?? 'application/octet-stream', name: a.url };
  if (a.drive_file_id) return openDriveFile(a.drive_file_id);
  if (!/^https:\/\//.test(a.url)) throw new Error('Asset URL is not https.');
  const res = await fetch(a.url, { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
  if (!res.ok || !res.body) throw new Error(`Asset host returned HTTP ${res.status}.`);
  return { body: res.body, size: res.headers.get('content-length'), mime: res.headers.get('content-type') ?? 'application/octet-stream', name: a.url };
}

media.get('/media/:file', async (req, res) => {
  const assetId = req.params.file.split('.')[0];
  const { exp = '', fmt = 'orig', sig = '' } = req.query as Record<string, string>;
  if (!/^[0-9a-f-]{36}$/.test(assetId) || !['orig', 'jpeg', 'feed'].includes(fmt) || !verifyMediaSignature(assetId, exp, fmt, sig)) {
    return res.status(403).send('Link expired or invalid.');
  }
  const { rows } = await query('SELECT url, drive_file_id, kind, data, mime FROM assets WHERE id = $1', [assetId]);
  if (!rows[0]) return res.status(404).send('Not found.');
  try {
    const file = await openAsset(rows[0]);
    res.setHeader('cache-control', 'private, max-age=300');
    if (fmt === 'orig') {
      res.setHeader('content-type', file.mime);
      if (file.size) res.setHeader('content-length', file.size);
      Readable.fromWeb(file.body as any).pipe(res);
      return;
    }
    // Instagram accepts JPEG only; feed images must also sit between 4:5 and 1.91:1.
    const input = Buffer.from(await new Response(file.body as any).arrayBuffer());
    let img = sharp(input, { failOn: 'none' }).rotate().flatten({ background: '#ffffff' });
    if (fmt === 'feed') {
      const meta = await sharp(input).metadata();
      const w = meta.width ?? 1080;
      const h = meta.height ?? 1080;
      const ratio = w / h;
      if (ratio < 0.8) {
        const target = Math.ceil(h * 0.8);
        const side = Math.ceil((target - w) / 2);
        img = img.extend({ left: side, right: side, background: '#ffffff' });
      } else if (ratio > 1.91) {
        const target = Math.ceil(w / 1.91);
        const pad = Math.ceil((target - h) / 2);
        img = img.extend({ top: pad, bottom: pad, background: '#ffffff' });
      }
    }
    const out = await img.resize({ width: 1440, height: 1800, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
    res.setHeader('content-type', 'image/jpeg');
    res.setHeader('content-length', String(out.length));
    res.end(out);
  } catch (e) {
    console.error('media route failed', (e as Error).message);
    res.status(502).send('Could not read the media file.');
  }
});
