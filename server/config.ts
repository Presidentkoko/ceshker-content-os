import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(8080),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DB_SCHEMA: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/, 'DB_SCHEMA must be a lowercase identifier')
    .default('content_os'),
  SESSION_SECRET: z.string().min(16, 'SESSION_SECRET must be at least 16 characters'),
  ADMIN_EMAIL: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),
  APP_TIMEZONE: z.string().default('America/Chicago'),
  GOOGLE_SHEET_ID: z.string().optional(),
  GOOGLE_SHEET_GID: z.string().default('0'),
  N8N_BASE_URL: z.string().optional(),
  N8N_PUBLISH_WEBHOOK_URL: z.string().optional(),
  N8N_WEBHOOK_SECRET: z.string().optional(),
  N8N_CALLBACK_SECRET: z.string().optional(),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  NFAMATION_DRIVE_FOLDER_ID: z.string().optional(),
  /** Which brand this deployment serves; see shared/brand.ts. */
  BRAND: z.enum(['ceshker', 'aim']).default('ceshker'),
  /** Drive folder with this brand's videos (preferred over NFAMATION_DRIVE_FOLDER_ID). */
  DRIVE_FOLDER_ID: z.string().optional(),
  /** First day (YYYY-MM-DD, app time zone) of a seeded content plan, e.g. the AIM 30-day plan. */
  PLAN_START_DATE: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  META_PAGE_ID: z.string().optional(),
  META_IG_USER_ID: z.string().optional(),
  YOUTUBE_CHANNEL_ID: z.string().optional(),
  RAILWAY_ENVIRONMENT_NAME: z.string().optional(),
  RAILWAY_SERVICE_NAME: z.string().optional(),
  RAILWAY_GIT_COMMIT_SHA: z.string().optional(),
  DISPATCHER_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),
});

const parsed = schema.safeParse(
  Object.fromEntries(Object.entries(process.env).map(([k, v]) => [k, v === '' ? undefined : v])),
);
if (!parsed.success) {
  console.error('Invalid configuration:\n' + parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n'));
  process.exit(1);
}

export const config = parsed.data;
export const isProd = config.NODE_ENV === 'production';
