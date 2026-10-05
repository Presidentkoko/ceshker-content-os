// End-to-end API verification against a running server.
// Usage: BASE=http://localhost:8080 PW=<seed password> node scripts/e2e.mjs
const BASE = process.env.BASE ?? 'http://localhost:8080';
const PW = process.env.PW;
const DOMAIN = process.env.SEED_DOMAIN ?? 'contentos.test';
let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};

const pwFor = (email) => `${PW}-${email.split('@')[0]}`;
async function session(email) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: pwFor(email) }) });
  const cookie = r.headers.get('set-cookie')?.split(';')[0];
  if (!r.ok) throw new Error(`login ${email} failed ${r.status}`);
  return async (method, path, body) => {
    const res = await fetch(`${BASE}/api${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  };
}

const health = await fetch(`${BASE}/healthz`).then((r) => r.json());
check('health endpoint', health.ok === true);
const anon = await fetch(`${BASE}/api/content`);
check('anonymous API access blocked', anon.status === 401);
const bad = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'wrong-password' }) });
check('wrong password rejected', bad.status === 401);

const admin = await session(`admin@${DOMAIN}`);
const cm = await session(`content.manager@${DOMAIN}`);
const ap = await session(`approver@${DOMAIN}`);
const viewer = await session(`viewer@${DOMAIN}`);

const list = await viewer('GET', '/content?page_size=5');
check('viewer can read library', list.status === 200 && list.body.total > 100, `total=${list.body.total}`);
const vCreate = await viewer('POST', '/content', { title: 'x', category: 'General', content_type: 'post' });
check('viewer cannot create', vCreate.status === 403);

const tomorrow = new Date(Date.now() + 86400000).toISOString();
const created = await cm('POST', '/content', {
  title: 'E2E test post', caption: 'Testing the approval pipeline.', category: 'Education', content_type: 'post', priority: 2,
  scheduled_at: tomorrow, timezone: 'America/Chicago', targets: [{ platform: 'facebook', placement: 'feed' }],
});
check('content manager creates draft', created.status === 201 && created.body.approval_status === 'draft', created.body.ref);
const id = created.body.id;
let v = created.body.version;

const badTarget = await cm('POST', '/content', { title: 'bad', category: 'General', content_type: 'post', targets: [{ platform: 'youtube', placement: 'story' }] });
check('invalid platform placement rejected', badTarget.status === 400);

const early = await cm('POST', `/content/${id}/queue`, { version: v });
check('unapproved content cannot be queued', early.status === 422);

const sub = await cm('POST', `/content/${id}/submit`, { version: v });
check('submit for approval', sub.status === 200 && sub.body.approval_status === 'pending');
v = sub.body.version;
const cmApprove = await cm('POST', `/content/${id}/approve`, { version: v });
check('content manager cannot approve', cmApprove.status === 403);
const noComment = await ap('POST', `/content/${id}/reject`, { version: v });
check('reject requires a comment', noComment.status === 400);
const stale = await ap('POST', `/content/${id}/approve`, { version: v - 1 });
check('stale version rejected (optimistic lock)', stale.status === 409);
const appr = await ap('POST', `/content/${id}/approve`, { version: v });
check('approver approves', appr.status === 200 && appr.body.approval_status === 'approved');
v = appr.body.version;

const q1 = await cm('POST', `/content/${id}/queue`, { version: v });
check('approved content queued', q1.status === 200 && q1.body.added?.length === 1);
const q2 = await cm('POST', `/content/${id}/queue`, { version: v });
check('double queue blocked', q2.status === 409);

let detail = await cm('GET', `/content/${id}`);
const queueId = detail.body.queue[0].id;
const pause = await cm('POST', `/queue/${queueId}/pause`);
check('pause queued post', pause.status === 200);
const resume = await cm('POST', `/queue/${queueId}/resume`);
check('resume queued post', resume.status === 200);
const vPause = await viewer('POST', `/queue/${queueId}/pause`);
check('viewer cannot pause', vPause.status === 403);

const dry = await cm('POST', `/content/${id}/dry-run`);
check('dry run builds payloads without publishing', dry.status === 200 && dry.body.payloads.length === 1 && dry.body.publish_blockers.some((b) => b.code === 'connection_missing'));

const edit = await cm('PATCH', `/content/${id}`, { caption: 'Changed after approval', version: detail.body.item.version });
check('substantive edit resets approval', edit.status === 200 && edit.body.approvalReset === true && edit.body.item.approval_status === 'draft');
detail = await cm('GET', `/content/${id}`);
check('queue entry cancelled after edit', detail.body.queue.every((q) => q.state === 'cancelled'));
v = detail.body.item.version;

const manualEarly = await cm('POST', `/content/${id}/publications`, { target_id: detail.body.item.targets[0].id });
check('unapproved content cannot be recorded published', manualEarly.status === 409);
v = (await cm('POST', `/content/${id}/submit`, { version: v })).body.version;
v = (await ap('POST', `/content/${id}/approve`, { version: v })).body.version;
const t = detail.body.item.targets[0].id;
const m1 = await cm('POST', `/content/${id}/publications`, { target_id: t, public_url: 'https://www.facebook.com/example/posts/1' });
check('record manual publication', m1.status === 200 && m1.body.item.publish_status === 'published');
const m2 = await cm('POST', `/content/${id}/publications`, { target_id: t });
check('duplicate publication blocked', m2.status === 409);
const lockedEdit = await cm('PATCH', `/content/${id}`, { title: 'nope', version: m1.body.item.version });
check('published content is locked', lockedEdit.status === 409);

const auto = await admin('POST', '/connections/facebook/automation', { enabled: true, confirm: 'facebook' });
check('automation cannot be enabled without a live connection', auto.status === 412);
const cmAuto = await cm('POST', '/connections/facebook/automation', { enabled: true, confirm: 'facebook' });
check('non-admin cannot change automation', cmAuto.status === 403);
const pg = await admin('POST', '/connections/postgres/test');
check('safe connection test (postgres)', pg.status === 200 && pg.body.ok === true);

const conns = await admin('GET', '/connections');
const raw = JSON.stringify(conns.body);
check('connections expose no secrets', !/postgres:\/\/|password|private_key|SESSION_SECRET/i.test(raw));

const dup = await cm('POST', `/content/${id}/duplicate`);
check('duplicate record', dup.status === 201 && dup.body.approval_status === 'draft' && dup.body.scheduled_at === null);
const arch = await cm('POST', `/content/${dup.body.id}/archive`, { archived: true });
check('archive record', arch.status === 200 && !!arch.body.archived_at);
const vArch = await viewer('POST', `/content/${dup.body.id}/archive`, { archived: false });
check('viewer cannot restore', vArch.status === 403);

const csv = await fetch(`${BASE}/api/content/export.csv?category=Education`, { headers: { cookie: (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: pwFor(`viewer@${DOMAIN}`) }) })).headers.get('set-cookie').split(';')[0] } });
const csvText = await csv.text();
check('filtered CSV export', csv.status === 200 && csvText.includes('E2E test post'));

const audit = await admin('GET', `/activity?q=${detail.body.item.ref}`);
const actions = audit.body.items.map((a) => a.action);
check('audit log records the workflow', ['content.create', 'approval.submit', 'approval.approve', 'queue.add', 'content.update', 'publication.record_manual'].every((a) => actions.includes(a)), `${audit.body.total} entries`);
const denied = await admin('GET', '/activity?result=denied');
check('denied attempts are audited', denied.body.total > 0);

const vids = await viewer('GET', '/videos');
check('video library loads', vids.status === 200 && vids.body.length > 0, `${vids.body.length} videos`);
const deriv = await cm('POST', `/videos/${vids.body[0].id}/derivatives`, { kind: 'carousel' });
check('create social derivative from video', deriv.status === 201 || deriv.status === 409);
const ov = await viewer('GET', '/overview');
check('overview loads', ov.status === 200 && typeof ov.body.kpis.published === 'number');
const an = await viewer('GET', '/analytics');
check('analytics loads', an.status === 200 && an.body.by_category.length > 0);
const sync = await cm('POST', '/sync/sheet');
check('sheet re-import is idempotent', sync.status === 200 && sync.body.created === 0, JSON.stringify({ created: sync.body.created, updated: sync.body.updated, unchanged: sync.body.unchanged }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
