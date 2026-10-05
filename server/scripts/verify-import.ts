// Verifies importing an image by link, storing it, and serving it through the signed media route.
import sharp from 'sharp';
import { pool, query } from '../db/pool.js';
import { migrate } from '../db/migrate.js';
import { importAsset } from '../services/content.js';
import { signedMediaUrl } from '../services/meta.js';

const url = process.argv[2];
const admin = (await query(`SELECT id, email, name, role FROM users WHERE role = 'admin' LIMIT 1`)).rows[0];
await migrate();
const c = (await query(`INSERT INTO content_items (title, caption, category) VALUES ('Import verification', 'x', 'General') RETURNING id`)).rows[0];
let ok = true;
try {
  const a = await importAsset(c.id, { url, label: 'Canva export', approved: true }, admin);
  console.log('PASS  imported', a.mime, a.size_bytes, 'bytes');
  const res = await fetch(signedMediaUrl(a.id, { feed: true }));
  const buf = Buffer.from(await res.arrayBuffer());
  const m = await sharp(buf).metadata();
  const pass = res.status === 200 && m.format === 'jpeg';
  ok &&= pass;
  console.log(`${pass ? 'PASS' : 'FAIL'}  served stored copy as JPEG ${m.width}x${m.height}`);
  const priv = await importAsset(c.id, { url: 'https://localhost/x.png' }, admin).then(() => false).catch((e) => /public https/.test(e.message));
  ok &&= priv;
  console.log(`${priv ? 'PASS' : 'FAIL'}  private-network link refused`);
} finally {
  await query('DELETE FROM content_items WHERE id = $1', [c.id]);
  await pool.end();
}
process.exit(ok ? 0 : 1);
