import { config } from './config.js';
import { createApp } from './app.js';
import { migrate } from './db/migrate.js';
import { ensureConnectionRows } from './services/connections.js';
import { startDispatcher } from './services/queue.js';
import { bootstrap } from './scripts/bootstrap.js';
import { pool } from './db/pool.js';
import { syncSheet } from './services/sheetSync.js';
import { syncPublicDrive } from './services/library.js';
import { runCanvaAutomation } from './services/canva.js';
import { driveFolderId } from './brand.js';

async function main() {
  await migrate();
  await ensureConnectionRows();
  await bootstrap();
  const app = createApp();
  app.listen(config.PORT, () => console.log(`Content OS listening on :${config.PORT}`));
  if (config.DISPATCHER_ENABLED) startDispatcher();
  startBackgroundSync();
}

/**
 * Keeps the database in step with the planning sheet (every SHEET_SYNC_MINUTES, default 15) and
 * the NFAMation Drive folder (hourly), and runs the Canva rule every 30 minutes. An advisory lock stops replicas syncing at the same time.
 */
function startBackgroundSync() {
  const minutes = Math.max(5, Number(process.env.SHEET_SYNC_MINUTES ?? 15));
  const locked = async (lockId: number, fn: () => Promise<unknown>) => {
    const c = await pool.connect();
    try {
      const { rows } = await c.query('SELECT pg_try_advisory_lock($1) AS ok', [lockId]);
      if (!rows[0].ok) return;
      try {
        await fn();
      } finally {
        await c.query('SELECT pg_advisory_unlock($1)', [lockId]);
      }
    } catch (e) {
      console.error('background sync failed:', (e as Error).message);
    } finally {
      c.release();
    }
  };
  const sheet = () => config.GOOGLE_SHEET_ID && locked(727301, () => syncSheet(null));
  const drive = () => driveFolderId() && locked(727302, () => syncPublicDrive(null));
  setTimeout(sheet, 15_000).unref();
  setTimeout(drive, 45_000).unref();
  setInterval(sheet, minutes * 60_000).unref();
  setInterval(drive, 60 * 60_000).unref();
  // Canva graphics for upcoming posts that have none (only while an admin has the rule switched on).
  const canva = () => locked(727303, async () => {
    const r = await runCanvaAutomation();
    if (r.results.length) console.log('canva automation:', JSON.stringify(r.results));
  });
  setTimeout(canva, 90_000).unref();
  setInterval(canva, 30 * 60_000).unref();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
