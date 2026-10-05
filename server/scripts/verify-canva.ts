// Verifies the Canva flow end to end against a mocked Canva API: token refresh (single-use
// rotation), brand-template autofill, PNG export, storage as an unapproved asset, the automation
// rule's candidate selection, and exporting an existing design.
import sharp from 'sharp';
import { pool, query } from '../db/pool.js';
import { migrate } from '../db/migrate.js';
import { seal, open } from '../services/secretbox.js';

process.env.CANVA_CLIENT_ID = 'test-client';
process.env.CANVA_CLIENT_SECRET = 'test-secret';
const { generateForContent, getRule, ruleCandidates, runCanvaAutomation, setRule, canvaConnection, listTemplates, pickTemplate, autoGenerate } = await import('../services/canva.js');

const png = await sharp({ create: { width: 1080, height: 1080, channels: 3, background: '#223355' } }).png().toBuffer();
const calls: string[] = [];
let autofillBody: any = null;
let refreshes = 0;
const extra: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = String(input);
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  if (url.startsWith('https://export-download.canva.com/')) return new Response(png, { status: 200 });
  if (!url.startsWith('https://api.canva.com/rest/v1')) return realFetch(input, init);
  const path = url.slice('https://api.canva.com/rest/v1'.length);
  calls.push(`${init.method ?? 'GET'} ${path}`);
  if (path === '/oauth/token') {
    if (init.headers.authorization !== `Basic ${Buffer.from('test-client:test-secret').toString('base64')}`) return json({ error: 'invalid_client' }, 401);
    const body = new URLSearchParams(String(init.body));
    if (body.get('refresh_token') !== `refresh-${refreshes}`) return json({ error: 'invalid_grant', error_description: 'refresh token reused' }, 400);
    refreshes++;
    return json({ access_token: `access-${refreshes}`, refresh_token: `refresh-${refreshes}`, expires_in: 14400, scope: 'x' });
  }
  if (!String(init.headers?.authorization).startsWith('Bearer access-')) return json({ message: 'unauthorized' }, 401);
  if (path === '/brand-templates/TPL123/dataset') return json({ dataset: { headline: { type: 'text' }, date: { type: 'text' }, footer: { type: 'text' }, photo: { type: 'image' } } });
  if (path === '/autofills' && init.method === 'POST') { autofillBody = JSON.parse(init.body); return json({ job: { id: 'job1', status: 'in_progress' } }); }
  if (path === '/autofills/job1') return json({ job: { id: 'job1', status: 'success', result: { type: 'create_design', design: { id: 'DAGtest1234', title: 'Autofilled', urls: { edit_url: 'https://www.canva.com/design/DAGtest1234/edit' } } } } });
  if (path === '/exports' && init.method === 'POST') return json({ job: { id: 'exp1', status: 'in_progress' } });
  if (path === '/exports/exp1') return json({ job: { id: 'exp1', status: 'success', urls: ['https://export-download.canva.com/x.png'] } });
  if (path.startsWith('/designs?')) return json({ items: [{ id: 'DTPLtest123', title: 'Content OS – Black Sheep Template' }, { id: 'DGENtest456', title: 'Content OS – Ceshker Post Template' }, { id: 'DNOFIELDS01', title: 'Old Template draft' }] });
  if (path === '/designs/DGENtest456/dataset') return json({ dataset: { headline: { type: 'text' }, campaign: { type: 'text' }, caption: { type: 'text' }, category: { type: 'text' } } });
  if (path === '/designs/DNOFIELDS01/dataset') return json({ dataset: {} });
  if (path === '/designs/DTPLtest123/dataset') return json({ dataset: { headline: { type: 'text' }, campaign: { type: 'text' }, date: { type: 'text' } } });
  if (path === '/designs/DAGexist999') return json({ design: { id: 'DAGexist999', title: 'Day 1 post' } });
  return json({ message: `unmocked ${path}` }, 404);
}) as typeof fetch;

await migrate();
const admin = (await query(`SELECT id, email, name, role FROM users WHERE role = 'admin' AND active LIMIT 1`)).rows[0];
let ok = true;
const check = (pass: boolean, what: string) => { ok &&= pass; console.log(`${pass ? 'PASS' : 'FAIL'}  ${what}`); };
const prevRule = (await query(`SELECT value FROM settings WHERE key = 'canva_automation'`)).rows[0]?.value ?? null;
const prevToken = (await query(`SELECT 1 FROM oauth_tokens WHERE provider = 'canva'`)).rowCount;
if (prevToken) throw new Error('A real Canva connection exists in this database; not touching it.');
await query(
  `INSERT INTO oauth_tokens (provider, account_name, scopes, access_token_enc, refresh_token_enc, expires_at, connected_by)
   VALUES ('canva', 'Test user', 'x', $1, $2, now() - interval '1 hour', $3)`,
  [seal('expired'), seal('refresh-0'), admin.id],
);
const c = (await query(
  `INSERT INTO content_items (title, caption, category, content_type, scheduled_at) VALUES ('Open House Day 1', 'Doors open at 9. Bring a friend!', 'Event', 'post', now() + interval '2 minutes') RETURNING id`,
)).rows[0];
await query(`INSERT INTO content_targets (content_id, platform, placement) VALUES ($1, 'facebook', 'feed')`, [c.id]);
try {
  check(!!(await canvaConnection()), 'connection row visible');
  await setRule({ template_id: 'TPL123', template_title: 'Event post', mapping: { footer: 'none' }, max_per_run: 1, enabled: true }, admin);
  const rule = await getRule();
  check(rule.enabled && rule.enabled_by === admin.id, 'rule switched on, attributed to the admin');
  const cands = await ruleCandidates(rule, 50);
  check(cands.some((x) => x.id === c.id), 'post without an image is a candidate');

  const run1 = await runCanvaAutomation();
  const mine = run1.results.length;
  check(run1.ran && mine === 1 && run1.results[0].ok, `automation ran: ${JSON.stringify(run1.results)}`);
  check(refreshes === 1, 'expired token refreshed exactly once (single-use refresh token rotated)');
  const stored = (await query(`SELECT refresh_token_enc FROM oauth_tokens WHERE provider = 'canva'`)).rows[0];
  check(open(stored.refresh_token_enc) === 'refresh-1', 'new refresh token stored');
  check(autofillBody?.brand_template_id === 'TPL123' && autofillBody.data.headline?.text === 'Open House Day 1' && !!autofillBody.data.date?.text && !autofillBody.data.footer && !autofillBody.data.photo, 'autofill: headline=title, date filled, footer left, image field skipped');
  const a = (await query(`SELECT approved, mime, size_bytes, url, label FROM assets WHERE content_id = $1`, [c.id])).rows;
  check(a.length === 1 && !a[0].approved && a[0].mime === 'image/png' && a[0].size_bytes === png.length, 'PNG stored on the post, not approved');
  check(a[0].url === 'https://www.canva.com/design/DAGtest1234/edit', 'asset links back to the Canva design');

  const again = await ruleCandidates(await getRule(), 50);
  check(!again.some((x) => x.id === c.id), 'post with an image is no longer a candidate');

  const d = await generateForContent(c.id, { mode: 'design', design: 'https://www.canva.com/design/DAGexist999/abc/edit' }, admin);
  check(d.design_id === 'DAGexist999' && !d.asset.approved, 'existing design exported and stored unapproved');
  const bad = await generateForContent(c.id, { mode: 'design', design: 'https://example.com/nope' }, admin).then(() => false).catch((e) => /canva\.com\/design/.test(e.message));
  check(bad, 'non-Canva link refused');
  const runs = (await query(`SELECT status FROM workflow_runs WHERE kind = 'canva_generate' AND content_id = $1 ORDER BY started_at`, [c.id])).rows.map((r) => r.status);
  check(runs.join() === 'succeeded,succeeded,failed', `runs logged (${runs.join()})`);

  // A design with data fields works as a template (no brand-template publishing rights needed).
  const t2 = (await query(
    `INSERT INTO content_items (title, caption, category, content_type, scheduled_at) VALUES ('Black Sheep Convention – Mortgage Wraps Done Right', 'x', 'Event', 'post', '2026-09-26T15:00:00Z') RETURNING id`,
  )).rows[0];
  extra.push(t2.id);
  await generateForContent(t2.id, { mode: 'template', template_id: 'DTPLtest123', template_kind: 'design' }, admin);
  const b = autofillBody;
  check(b.type === 'create_from_design' && b.design_id === 'DTPLtest123' && !b.brand_template_id, 'design template autofilled with create_from_design');
  check(b.data.headline?.text === 'Mortgage Wraps Done Right' && b.data.campaign?.text === 'Black Sheep Convention', `title split: "${b.data.campaign?.text}" / "${b.data.headline?.text}"`);
  check(b.data.date?.text === 'Saturday, September 26 • 10:00 AM', `date filled as "${b.data.date?.text}"`);

  // Routing: each post gets the template whose keyword it mentions, else the generic one.
  await setRule({ enabled: false, template_id: null }, admin);
  const list = await listTemplates();
  check(list.map((t) => t.id).join() === 'DTPLtest123,DGENtest456', `templates listed: ${list.map((t) => t.title).join(' | ')} (design without fields skipped)`);
  check((await pickTemplate(t2.id)).id === 'DTPLtest123', 'Black Sheep post → Black Sheep template');
  const t3 = (await query(
    `INSERT INTO content_items (title, caption, category, content_type) VALUES ('Belated Employee Anniversary – Corey Sorensen', 'Happy belated work anniversary to Corey Sorensen, who has spent five wonderful years helping our clients close on time and with confidence! Thank you.', 'Anniversary', 'post') RETURNING id`,
  )).rows[0];
  extra.push(t3.id);
  const g = await autoGenerate(t3.id, admin);
  const gb = autofillBody;
  check(g.template === 'Content OS – Ceshker Post Template' && gb.design_id === 'DGENtest456', `other post → generic template (${g.template})`);
  check(gb.data.headline?.text === 'Corey Sorensen' && gb.data.campaign?.text === 'Belated Employee Anniversary' && gb.data.category?.text === 'Anniversary', 'generic fields: name, eyebrow, category');
  check(gb.data.caption?.text.length <= 111 && gb.data.caption.text.endsWith('…'), `long caption shortened: "${gb.data.caption?.text}"`);
} finally {
  await query(`DELETE FROM workflow_runs WHERE kind = 'canva_generate' AND content_id = $1`, [c.id]);
  for (const id of [c.id, ...extra]) {
    await query(`DELETE FROM workflow_runs WHERE kind = 'canva_generate' AND content_id = $1`, [id]);
    await query('DELETE FROM content_items WHERE id = $1', [id]);
  }
  await query(`DELETE FROM oauth_tokens WHERE provider = 'canva'`);
  if (prevRule) await query(`UPDATE settings SET value = $1 WHERE key = 'canva_automation'`, [JSON.stringify(prevRule)]);
  else await query(`DELETE FROM settings WHERE key = 'canva_automation'`);
  await pool.end();
}
console.log(`\nCanva API calls: ${calls.length}`);
process.exit(ok ? 0 : 1);
