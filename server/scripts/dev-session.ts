import crypto from 'node:crypto';
import { pool, query } from '../db/pool.js';
const email = process.argv[2] ?? 'admin@contentos.test';
const token = crypto.randomBytes(32).toString('base64url');
const hash = crypto.createHmac('sha256', process.env.SESSION_SECRET!).update(token).digest('hex');
const u = await query('SELECT id FROM users WHERE email = $1', [email]);
await query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '4 hours')", [hash, u.rows[0].id]);
console.log(token);
await pool.end();
