import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

let resolvedFirebaseProjectId = '';
try {
  const cfgPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
  if (fs.existsSync(cfgPath)) {
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as { projectId?: string };
    resolvedFirebaseProjectId = (raw.projectId || '').trim();
  }
} catch {
  // Ignore unreadable firebase config
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  VERCEL: z.string().optional().default(''),
  VERCEL_URL: z.string().optional().default(''),
  VERCEL_BRANCH_URL: z.string().optional().default(''),
  VERCEL_PROJECT_PRODUCTION_URL: z.string().optional().default(''),
  DATABASE_URL: z.string().optional().default(''),
  POSTGRES_URL: z.string().optional().default(''),
  SESSION_SECRET: z.string().optional().default(''),
  REFRESH_SECRET: z.string().optional().default(''),
  DATA_ENCRYPTION_KEY: z.string().optional().default(''),
  SEED_ADMIN_EMAIL: z.string().optional().default(''),
  SEED_ADMIN_PASSWORD: z.string().optional().default(''),
  GEMINI_API_KEY: z.string().optional().default(''),
  ANTHROPIC_API_KEY: z.string().optional().default(''),
  STORAGE_DRIVER: z.enum(['vercel_blob', 'gcs', 'local']).optional(),
  BLOB_READ_WRITE_TOKEN: z.string().optional().default(''),
  GCS_BUCKET: z.string().optional().default(''),
  GCS_SERVICE_ACCOUNT_JSON: z.string().optional().default(''),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(200).default(50),
  CORS_ORIGIN: z.string().optional().default(''),
  APP_URL: z.string().optional().default('http://localhost:3000'),
  APP_PORT: z.coerce.number().int().optional(),
  PORT: z.coerce.number().int().optional(),
  NGINX_PORT: z.coerce.number().int().optional(),
});

const parsed = EnvSchema.parse(process.env);

const explicitSessionSecret = (parsed.SESSION_SECRET || parsed.REFRESH_SECRET).trim();
const ephemeralSessionFallback = !explicitSessionSecret ? crypto.randomBytes(32).toString('hex') : '';
const ephemeralRefreshFallback = !parsed.REFRESH_SECRET ? crypto.randomBytes(32).toString('hex') : '';

if (parsed.NODE_ENV === 'production' && !explicitSessionSecret) {
  console.warn('[MARSFORCE] SESSION_SECRET is unset; using DB-persisted or in-memory signing secret.');
}

// Always bind to port 3000 when NGINX_PORT is proxying on 8080, or use APP_PORT/3000
const resolvedPort =
  parsed.APP_PORT ||
  (parsed.NGINX_PORT ? 3000 : parsed.PORT) ||
  3000;

const vercelOrigins = [
  parsed.VERCEL_URL,
  parsed.VERCEL_BRANCH_URL,
  parsed.VERCEL_PROJECT_PRODUCTION_URL,
]
  .map((host) => host.trim())
  .filter(Boolean)
  .map((host) => (host.startsWith('http://') || host.startsWith('https://') ? host : `https://${host}`));

const resolvedStorageDriver =
  parsed.STORAGE_DRIVER ||
  (parsed.BLOB_READ_WRITE_TOKEN.trim()
    ? 'vercel_blob'
    : parsed.GCS_BUCKET && parsed.GCS_SERVICE_ACCOUNT_JSON
      ? 'gcs'
      : 'local');

export const AUTHORIZED_PRIMARY_GOOGLE_EMAIL = 'vishwa10230506@gmail.com';

export const env = {
  nodeEnv: parsed.NODE_ENV,
  isProd: parsed.NODE_ENV === 'production',
  isVercel: parsed.VERCEL === '1' || Boolean(parsed.VERCEL_URL),
  vercelOrigins,
  databaseUrl: (parsed.DATABASE_URL || parsed.POSTGRES_URL).trim(),
  hasExplicitSessionSecret: Boolean(explicitSessionSecret),
  sessionSecret: explicitSessionSecret || ephemeralSessionFallback,
  refreshSecret: parsed.REFRESH_SECRET.trim() || explicitSessionSecret || ephemeralRefreshFallback,
  dataEncryptionKey: parsed.DATA_ENCRYPTION_KEY.trim(),
  seedAdminEmail: parsed.SEED_ADMIN_EMAIL.trim().toLowerCase(),
  seedAdminPassword: parsed.SEED_ADMIN_PASSWORD,
  authorizedGoogleEmail: AUTHORIZED_PRIMARY_GOOGLE_EMAIL,
  firebaseProjectId: resolvedFirebaseProjectId,
  geminiApiKey: parsed.GEMINI_API_KEY.trim(),
  anthropicApiKey: parsed.ANTHROPIC_API_KEY.trim(),
  storageDriver: resolvedStorageDriver,
  blobReadWriteToken: parsed.BLOB_READ_WRITE_TOKEN.trim(),
  gcsBucket: parsed.GCS_BUCKET.trim(),
  gcsServiceAccountJson: parsed.GCS_SERVICE_ACCOUNT_JSON.trim(),
  maxUploadMb: parsed.MAX_UPLOAD_MB,
  corsOrigins: parsed.CORS_ORIGIN
    ? parsed.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean)
    : [],
  appUrl: parsed.APP_URL,
  port: resolvedPort,
};
