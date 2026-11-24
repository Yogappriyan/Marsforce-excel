import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApiApp } from '../server/app.ts';
import { runMigrations } from '../server/infrastructure/db/index.ts';
import { getSigningSecret } from '../server/middleware/security.ts';
import { authService } from '../server/modules/auth/auth.module.ts';

const app = createApiApp();
let initPromise: Promise<void> | null = null;

async function ensureInitialized(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      await runMigrations();
      await getSigningSecret();
      await authService.seedSuperAdminFromEnv();
    })().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  await initPromise;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    await ensureInitialized();
    await new Promise<void>((resolve) => {
      res.once('finish', resolve);
      res.once('close', resolve);
      app(req as any, res as any);
    });
  } catch (err) {
    console.error('[MARSFORCE Vercel API Error]', err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(
        JSON.stringify({
          error: {
            code: 'SERVERLESS_INIT_ERROR',
            message: 'Backend initialization failed. Verify DATABASE_URL and environment configuration.',
          },
        })
      );
    }
  }
}
