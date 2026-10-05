// API-level checks for the Meta integration (no real Meta credentials needed).
// Usage: PW=<seed password> node scripts/meta-check.mjs
const BASE = process.env.BASE ?? 'http://localhost:8080';
const PW = process.env.PW;
let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};
async function session(local) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: `${PW}-${local}` }) });
  const cookie = r.headers.get('set-cookie')?.split(';')[0];
  return async (method, path, body) => {
    const res = await fetch(`${BASE}/api${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const t = await res.text();
    let j;
    try { j = JSON.parse(t); } catch { j = t; }
    return { status: res.status, body: j };
  };
}
const admin = await session('admin');
const cm = await session('content.manager');

// Destinations carry a Page choice.
const c = await cm('POST', '/content', {
  title: 'Meta check', caption: 'Hello', category: 'General', content_type: 'post',
  targets: [{ platform: 'facebook', placement: 'feed', account_id: '111111111111' }, { platform: 'instagram', placement: 'feed' }],
});
check('create post with a chosen Facebook Page', c.status === 201 && c.body.targets.some((t) => t.platform === 'facebook' && t.account_id === '111111111111'));
check('Instagram destination defaults to the default Page', c.body.targets.some((t) => t.platform === 'instagram' && t.account_id === null));
const bad = await cm('POST', '/content', { title: 'x', category: 'General', content_type: 'post', targets: [{ platform: 'facebook', placement: 'feed', account_id: 'not-a-page' }] });
check('malformed Page id rejected', bad.status === 400);

// Changing only the Page is a substantive change (approver must see where it posts).
const u = await cm('PATCH', `/content/${c.body.id}`, { version: c.body.version, targets: [{ platform: 'facebook', placement: 'feed', account_id: '222222222222' }, { platform: 'instagram', placement: 'feed' }] });
check('switching Page updates the destination', u.status === 200 && u.body.item.targets.some((t) => t.account_id === '222222222222') && !u.body.item.targets.some((t) => t.account_id === '111111111111'));

// New validation rules.
const reel = await cm('POST', '/content', { title: 'Reel check', caption: 'x', category: 'General', content_type: 'reel', targets: [{ platform: 'instagram', placement: 'reel' }] });
check('Reel without a video is flagged', reel.body.issues.some((i) => i.code === 'reel_needs_video'));
const story = await cm('POST', '/content', { title: 'Story check', caption: 'x', category: 'General', content_type: 'story', targets: [{ platform: 'facebook', placement: 'story' }] });
check('Facebook Story without an image is flagged', story.body.issues.some((i) => i.code === 'fb_story_needs_image'));

// Connections without a token.
const conns = await admin('GET', '/connections');
const fb = conns.body.find((x) => x.key === 'facebook');
check('Facebook card asks for the system-user token', fb.status === 'not_configured' && /META_SYSTEM_USER_TOKEN/.test(fb.blocker) && fb.meta?.token_configured === false);
check('no token value is exposed', !/EAA[A-Za-z0-9]{10,}/.test(JSON.stringify(conns.body)));
const sync = await admin('POST', '/meta/pages/sync');
check('Load Pages refuses without a token', sync.status === 412);
const cmSync = await cm('POST', '/meta/pages/sync');
check('non-admin cannot load or change Pages', cmSync.status === 403);
const meta = await cm('GET', '/meta');
check('form metadata lists publishing Pages (none yet)', Array.isArray(meta.body.meta_pages));

// Clean up the test records.
for (const r of [c, reel, story]) await cm('POST', `/content/${r.body.id}/archive`, { archived: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
