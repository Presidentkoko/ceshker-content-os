// Creates one test user per role and imports the planning sheet.
// Sign-in is password-only, so each test user's password is SEED_PASSWORD-<role>, e.g. <pw>-content.manager.
// Usage: SEED_PASSWORD=... npm run seed
import { query, pool } from '../db/pool.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../auth.js';
import { bootstrap } from './bootstrap.js';
import { ensureConnectionRows } from '../services/connections.js';
import { syncSheet } from '../services/sheetSync.js';

const password = process.env.SEED_PASSWORD;
if (!password || password.length < 10) {
  console.error('Set SEED_PASSWORD (10+ characters) for the test users.');
  process.exit(1);
}
const domain = process.env.SEED_DOMAIN ?? 'contentos.test';

await migrate();
await ensureConnectionRows();
await bootstrap();
for (const [role, name] of [
  ['admin', 'Test Administrator'],
  ['content_manager', 'Test Content Manager'],
  ['approver', 'Test Approver'],
  ['viewer', 'Test Viewer'],
] as const) {
  const email = `${role.replace('_', '.')}@${domain}`;
  await query(
    `INSERT INTO users (email, name, role, password_hash) VALUES ($1,$2,$3,$4)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, active = true`,
    [email, name, role, await hashPassword(`${password}-${role.replace('_', '.')}`)],
  );
  console.log(`user ${email} (${role})`);
}
const summary = await syncSheet(null);
console.log('sheet import', summary);
await pool.end();
