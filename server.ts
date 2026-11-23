import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { createApiApp } from './server/app.ts';
import { env } from './server/config/env.ts';
import { getDb, runMigrations } from './server/infrastructure/db/index.ts';
import { jobWorker } from './server/infrastructure/queue/PostgresJobWorker.ts';
import { authService } from './server/modules/auth/auth.module.ts';

async function bootstrap() {
  await runMigrations();
  await authService.seedSuperAdminFromEnv();
  await jobWorker.start();

  const app = createApiApp();

  if (!env.isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }
  }

  const server = app.listen(env.port, '0.0.0.0', () => {
    console.log(`[MARSFORCE] Server listening on http://0.0.0.0:${env.port} (${env.nodeEnv}) | DB: ${getDb().engineLabel}`);
  });

  const shutdown = async () => {
    await jobWorker.stop();
    await getDb().close();
    server.close(() => process.exit(0));
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

bootstrap().catch((err) => {
  console.error('[MARSFORCE] Fatal startup failure:', err);
  process.exit(1);
});
