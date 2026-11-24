import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { env } from './config/env.ts';
import { generalApiRateLimiter, requireSameOriginForCookieMutations } from './middleware/security.ts';
import { createAuditRouter } from './modules/audit/audit.module.ts';
import { createAuthRouter } from './modules/auth/auth.module.ts';
import { createCategorisationRouter } from './modules/categorisation/categorisation.module.ts';
import { createDuplicatesRouter } from './modules/duplicates/duplicates.module.ts';
import { createExportsRouter } from './modules/exports/exports.module.ts';
import { createGeoRouter } from './modules/geo/geo.module.ts';
import { createJobsRouter } from './modules/jobs/jobs.module.ts';
import { createProcessingRouter, createTemplatesRouter } from './modules/processing/processing.module.ts';
import { createRecordsRouter } from './modules/records/records.module.ts';
import { createSettingsRouter } from './modules/settings/settings.module.ts';
import { createSamplesRouter, createUploadsRouter } from './modules/uploads/uploads.module.ts';
import { createUsersRouter } from './modules/users/users.module.ts';

export function createApiApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: false,
      frameguard: false,
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: false,
      crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
      xContentTypeOptions: true,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    })
  );

  const allowedCorsOrigins = Array.from(new Set([...env.corsOrigins, ...env.vercelOrigins]));
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || env.corsOrigins.length === 0 || allowedCorsOrigins.includes(origin)) {
          return callback(null, true);
        }
        return callback(new Error('Origin not allowed by CORS policy'));
      },
      credentials: true,
    })
  );

  app.use(cookieParser());
  app.use(express.json({ limit: '25mb' }));
  app.use('/api/v1', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    next();
  });
  app.use('/api/v1', requireSameOriginForCookieMutations);
  app.use('/api/v1', generalApiRateLimiter);

  app.get('/api/v1/health', (_req, res) => {
    res.json({ status: 'ok', service: 'MARSFORCE' });
  });

  app.use('/api/v1/auth', createAuthRouter());
  app.use('/api/v1/users', createUsersRouter());
  app.use('/api/v1/uploads', createUploadsRouter());
  app.use('/api/v1/samples', createSamplesRouter());
  app.use('/api/v1/processing', createProcessingRouter());
  app.use('/api/v1/templates', createTemplatesRouter());
  app.use('/api/v1/jobs', createJobsRouter());
  app.use('/api/v1/records', createRecordsRouter());
  app.use('/api/v1/categories', createCategorisationRouter());
  app.use('/api/v1/geo', createGeoRouter());
  app.use('/api/v1/duplicates', createDuplicatesRouter());
  app.use('/api/v1/exports', createExportsRouter());
  app.use('/api/v1/audit', createAuditRouter());
  app.use('/api/v1/settings', createSettingsRouter());

  app.use('/api/v1', (_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'API route not found.' } });
  });

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err?.name === 'ZodError') {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: err.issues?.[0]?.message || 'Validation error',
        },
      });
    }
    const status = typeof err?.status === 'number' ? err.status : 500;
    console.error('[API Error]', err?.message || err);
    res.status(status).json({
      error: {
        code: err?.code || 'INTERNAL_ERROR',
        message: status >= 500 && env.isProd ? 'An internal server error occurred.' : err?.message || 'Internal error',
      },
    });
  });

  return app;
}
