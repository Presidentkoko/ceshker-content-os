import { query } from '../db/pool.js';
import { config } from '../config.js';
import bcrypt from 'bcryptjs';
import { hashPassword, usersWithPassword } from '../auth.js';
import { brand } from '../brand.js';
import { seedPlans } from './aimPlan.js';

/**
 * Idempotent first-run setup: the initial administrator (only when there are no
 * users) and the standing campaigns the planning sheet refers to.
 */
export async function bootstrap() {
  const users = await query('SELECT count(*) AS n FROM users');
  if (users.rows[0].n === 0) {
    if (config.ADMIN_EMAIL && config.ADMIN_PASSWORD) {
      await query(`INSERT INTO users (email, name, role, password_hash) VALUES (lower($1), 'Administrator', 'admin', $2)`, [
        config.ADMIN_EMAIL.trim(),
        await hashPassword(config.ADMIN_PASSWORD.trim()),
      ]);
      console.log(`Created initial administrator ${config.ADMIN_EMAIL}`);
    } else {
      console.warn('No users exist. Set ADMIN_EMAIL and ADMIN_PASSWORD to create the first administrator.');
    }
  }

  // Break-glass recovery: ADMIN_RESET_PASSWORD (set by an owner in Railway) resets or creates the
  // ADMIN_EMAIL administrator on startup. Remove the variable after signing in.
  const reset = process.env.ADMIN_RESET_PASSWORD?.trim();
  if (reset && config.ADMIN_EMAIL) {
    const existing = await query('SELECT id, password_hash, role, active FROM users WHERE lower(email) = lower($1)', [config.ADMIN_EMAIL.trim()]);
    const clash = (await usersWithPassword(reset, existing.rows[0]?.id)).length > 0;
    const e = existing.rows[0];
    // Already this password on an active admin: nothing to reset, so keep everyone signed in.
    const alreadySet = !!e && e.active && e.role === 'admin' && (await bcrypt.compare(reset, e.password_hash));
    if (alreadySet) {
      console.warn('ADMIN_RESET_PASSWORD is set but already in effect; no reset. Remove it from Railway when convenient.');
    } else if (reset.length < 10) {
      console.error('ADMIN_RESET_PASSWORD must be at least 10 characters; reset skipped.');
    } else if (clash) {
      console.error('ADMIN_RESET_PASSWORD matches another user\'s password; choose a different one. Reset skipped.');
    } else {
      const hash = await hashPassword(reset);
      const r = await query(
        `INSERT INTO users (email, name, role, password_hash) VALUES (lower($1), 'Administrator', 'admin', $2)
         ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'admin', active = true
         RETURNING id`,
        [config.ADMIN_EMAIL.trim(), hash],
      );
      await query('DELETE FROM sessions WHERE user_id = $1', [r.rows[0].id]);
      await query(
        `INSERT INTO audit_log (actor_email, action, entity_type, entity_id, result, detail)
         VALUES ('system', 'user.password_reset', 'user', $1, 'success', 'Reset via ADMIN_RESET_PASSWORD at startup')`,
        [r.rows[0].id],
      );
      console.warn(`Administrator password reset for ${config.ADMIN_EMAIL.trim().toLowerCase()}. Remove ADMIN_RESET_PASSWORD now.`);
    }
  }

  // Uploads run in-process; any still marked "uploading" at startup were interrupted by a restart.
  await query(`UPDATE videos SET youtube_upload_status = 'failed' WHERE youtube_upload_status = 'uploading'`);
  await query(`UPDATE workflow_runs SET status = 'failed', finished_at = now(), error = 'Interrupted by a service restart; retry the upload.'
    WHERE kind = 'youtube_upload' AND status = 'running'`);

  const campaigns = brand.campaigns;
  for (const c of campaigns) {
    await query(
      `INSERT INTO campaigns (slug, name, description, target_count, lead_magnet_name, cta_text)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (slug) DO NOTHING`,
      [c.slug, c.name, c.description, c.target_count, c.lead_magnet_name, c.cta_text],
    );
  }
  await query(
    `INSERT INTO settings (key, value) VALUES
       ('disclaimer', $1), ('default_post_time', '"10:00"')
     ON CONFLICT (key) DO NOTHING`,
    [JSON.stringify(brand.disclaimer)],
  );
  if (brand.voice) {
    await query(`INSERT INTO settings (key, value) VALUES ('brand_voice', $1) ON CONFLICT (key) DO NOTHING`, [JSON.stringify(brand.voice)]);
  }
  if (brand.key === 'aim') await seedPlans();
}
