// Checks the YouTube connect-link flow up to Google's consent screen: link creation, the public
// redirect, one-link-at-a-time, expiry/reuse, and the callback's state checks. Run with
//   npx tsx --env-file=.env scripts/connect-link-check.mts
process.env.GOOGLE_OAUTH_CLIENT_ID ||= 'test-client.apps.googleusercontent.com';
process.env.GOOGLE_OAUTH_CLIENT_SECRET ||= 'test-secret';
const { createApp } = await import('../server/app.js');
const { migrate } = await import('../server/db/migrate.js');
const { pool, query } = await import('../server/db/pool.js');
const { createConnectInvite } = await import('../server/services/googleOAuth.js');

await migrate();
const admin = (await query(`SELECT id, email, name, role FROM users WHERE role = 'admin' AND active LIMIT 1`)).rows[0];
const server = createApp().listen(0);
const base = `http://127.0.0.1:${(server.address() as any).port}`;
let ok = true;
const check = (pass: boolean, what: string) => { ok &&= pass; console.log(`${pass ? 'PASS' : 'FAIL'}  ${what}`); };
const path = (u: string) => new URL(u).pathname;

try {
  const first = await createConnectInvite(admin);
  const second = await createConnectInvite(admin);
  const r1 = await fetch(base + path(first.url), { redirect: 'manual' });
  check(r1.status === 410, 'older link stops working once a new one is made');

  const r2 = await fetch(base + path(second.url), { redirect: 'manual' });
  const loc = r2.headers.get('location') ?? '';
  const cookie = (r2.headers.get('set-cookie') ?? '').split(';')[0];
  check(r2.status === 302 && loc.startsWith('https://accounts.google.com/o/oauth2/v2/auth') && /scope=.*youtube/.test(loc), 'link redirects to Google consent (no dashboard login)');
  check(/^cos_oauth_state=inv\./.test(cookie), 'invite-bound state cookie set');
  const state = new URL(loc).searchParams.get('state');

  const bad = await fetch(`${base}/api/oauth/google/callback?state=wrong&code=x`, { headers: { cookie }, redirect: 'manual' });
  check(bad.status === 400 && /Sign-in session expired/.test(await bad.text()), 'callback rejects a mismatched state');

  const denied = await fetch(`${base}/api/oauth/google/callback?error=access_denied&state=${state}`, { headers: { cookie }, redirect: 'manual' });
  check(denied.status === 400 && /access_denied/.test(await denied.text()), 'owner clicking Cancel gets a clear page');

  const noSession = await fetch(`${base}/api/oauth/google/callback?state=x&code=y`, { redirect: 'manual' });
  check(noSession.status === 401, 'callback without a link or session is refused');

  const junk = await fetch(`${base}/api/connect/youtube/not-a-real-token-at-all-000000000000`, { redirect: 'manual' });
  check(junk.status === 410, 'unknown token refused');

  const create = await fetch(`${base}/api/oauth/google/invite`, { method: 'POST', redirect: 'manual' });
  check(create.status === 401, 'creating a link requires a signed-in administrator');

  await query(`UPDATE connect_invites SET expires_at = now() - interval '1 minute' WHERE used_at IS NULL AND revoked_at IS NULL`);
  const expired = await fetch(base + path(second.url), { redirect: 'manual' });
  check(expired.status === 410 && /expired/i.test(await expired.text()), 'expired link refused');
} finally {
  await query(`DELETE FROM connect_invites WHERE created_at > now() - interval '10 minutes'`);
  server.close();
  await pool.end();
}
process.exit(ok ? 0 : 1);
