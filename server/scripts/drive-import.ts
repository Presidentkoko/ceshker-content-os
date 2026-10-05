import { pool } from '../db/pool.js';
import { migrate } from '../db/migrate.js';
import { syncPublicDrive } from '../services/library.js';
await migrate();
console.log(await syncPublicDrive(null));
await pool.end();
