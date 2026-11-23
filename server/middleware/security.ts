import crypto from 'node:crypto';
import type { CookieOptions, NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import type { z } from 'zod';
import { env } from '../config/env.ts';
import { getDb } from '../infrastructure/db/index.ts';

export type UserRole = 'SUPER_ADMIN' | 'ADMIN' | 'DATA_PROCESSOR' | 'REVIEWER' | 'READ_ONLY';
export type PermissionCode =
  | 'view'
  | 'upload'
  | 'process'
  | 'edit'
  | 'approve'
  | 'export'
  | 'manage_users'
  | 'manage_settings'
  | 'delete';

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  isActive: boolean;
  permissions: PermissionCode[];
}

export interface AuthenticatedRequest extends Request {
  authUser?: AuthUser;
  sessionId?: string;
}

export const SESSION_COOKIE_NAME = 'marsforce_session';
export const REFRESH_COOKIE_NAME = 'marsforce_refresh';
export const LEGACY_SESSION_COOKIE_NAME = 'structiq_session';
export const LEGACY_REFRESH_COOKIE_NAME = 'structiq_refresh';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function isRequestHttps(req: Request): boolean {
  const xfProto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const origin = String(req.headers.origin || '');
  const referer = String(req.headers.referer || '');
  return Boolean(req.secure || xfProto === 'https' || origin.startsWith('https://') || referer.startsWith('https://'));
}

export function getCookieOptions(req: Request, maxAgeMs: number): CookieOptions {
  const isHttps = isRequestHttps(req);
  if (isHttps) {
    return {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      partitioned: true,
      path: '/',
      maxAge: maxAgeMs,
    } as CookieOptions;
  }
  return {
    httpOnly: true,
    secure: false,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeMs,
  };
}

export function getClearCookieOptions(req: Request): CookieOptions {
  const isHttps = isRequestHttps(req);
  if (isHttps) {
    return {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      partitioned: true,
      path: '/',
    } as CookieOptions;
  }
  return {
    httpOnly: true,
    secure: false,
    sameSite: 'lax',
    path: '/',
  };
}

export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 25,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many authentication attempts. Please try again in 15 minutes.',
    },
  },
});

export const uploadRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Upload rate limit reached. Please wait a few minutes before uploading again.',
    },
  },
});

export const generalApiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
});

export function validateBody<T>(schema: z.ZodType<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues[0]?.message || 'Invalid request body',
          details: parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        },
      });
    }
    req.body = parsed.data;
    next();
  };
}

export function validateUuidParams(...paramNames: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    for (const name of paramNames) {
      const val = req.params?.[name];
      if (!isValidUuid(val)) {
        return res.status(400).json({
          error: {
            code: 'INVALID_ID',
            message: `Parameter "${name}" must be a valid UUID.`,
          },
        });
      }
    }
    next();
  };
}

function extractOriginFromHeader(headerValue: string | undefined): { origin: string; host: string } | null {
  if (!headerValue) return null;
  try {
    const url = new URL(headerValue);
    return { origin: url.origin.toLowerCase(), host: url.host.toLowerCase() };
  } catch {
    return null;
  }
}

export function requireSameOriginForCookieMutations(req: Request, res: Response, next: NextFunction) {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return next();
  }

  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ') && authHeader.slice(7).trim().length > 0) {
    return next();
  }

  const originHeader = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  const refererHeader = typeof req.headers.referer === 'string' ? req.headers.referer : undefined;
  const sourceHeader = originHeader || refererHeader;
  if (!sourceHeader) {
    return next();
  }

  const parsedSource = extractOriginFromHeader(sourceHeader);
  if (!parsedSource) {
    return res.status(403).json({
      error: {
        code: 'CSRF_ORIGIN_MISMATCH',
        message: 'Cross-site mutating request rejected due to invalid Origin/Referer header.',
      },
    });
  }

  const expectedHost = String(req.get('x-forwarded-host') || req.get('host') || '')
    .split(',')[0]
    .trim()
    .toLowerCase();

  const allowedOrigins = new Set<string>();
  for (const allowed of [...env.corsOrigins, ...env.vercelOrigins]) {
    try {
      allowedOrigins.add(new URL(allowed).origin.toLowerCase());
    } catch {
      // Ignore malformed origin entries
    }
  }
  try {
    if (env.appUrl && /^https?:\/\//i.test(env.appUrl)) {
      allowedOrigins.add(new URL(env.appUrl).origin.toLowerCase());
    }
  } catch {
    // Ignore placeholder APP_URL
  }

  if (parsedSource.host === expectedHost || allowedOrigins.has(parsedSource.origin)) {
    return next();
  }

  return res.status(403).json({
    error: {
      code: 'CSRF_ORIGIN_MISMATCH',
      message: 'Cross-site mutating request rejected due to origin mismatch.',
    },
  });
}

export async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const primaryCookie =
      typeof req.cookies?.[SESSION_COOKIE_NAME] === 'string' && req.cookies[SESSION_COOKIE_NAME].length > 0
        ? req.cookies[SESSION_COOKIE_NAME]
        : undefined;
    const legacyCookie =
      typeof req.cookies?.[LEGACY_SESSION_COOKIE_NAME] === 'string' && req.cookies[LEGACY_SESSION_COOKIE_NAME].length > 0
        ? req.cookies[LEGACY_SESSION_COOKIE_NAME]
        : undefined;
    const cookieToken = primaryCookie || legacyCookie;
    const authHeader = req.headers.authorization;
    const bearerToken =
      typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7).trim() || undefined
        : undefined;

    const bearerHash = bearerToken ? hashToken(bearerToken) : null;
    const cookieHash = cookieToken ? hashToken(cookieToken) : null;
    const tokenHashes = Array.from(new Set([bearerHash, cookieHash].filter((t): t is string => Boolean(t))));
    if (tokenHashes.length === 0) {
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required.' },
      });
    }

    const db = getDb();
    const result = await db.query<{
      session_id: string;
      user_id: string;
      email: string;
      full_name: string;
      role: UserRole;
      is_active: boolean;
      expires_at: Date | string;
    }>(
      `SELECT s.id AS session_id, u.id AS user_id, u.email, u.full_name, u.role, u.is_active, s.expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.session_token_hash = ANY($1::text[])
         AND s.revoked_at IS NULL
         AND s.expires_at > NOW()
       ORDER BY CASE WHEN $2::text IS NOT NULL AND s.session_token_hash = $2 THEN 0 ELSE 1 END, s.created_at DESC
       LIMIT 1`,
      [tokenHashes, bearerHash]
    );

    const row = result.rows[0];
    if (!row || !row.is_active) {
      return res.status(401).json({
        error: { code: 'SESSION_INVALID', message: 'Session expired or invalid. Please sign in again.' },
      });
    }

    const permsRes = await db.query<{ permission: PermissionCode }>(
      `SELECT permission FROM role_permissions WHERE role = $1`,
      [row.role]
    );

    req.sessionId = row.session_id;
    req.authUser = {
      id: row.user_id,
      email: row.email,
      fullName: row.full_name,
      role: row.role,
      isActive: row.is_active,
      permissions: permsRes.rows.map((r) => r.permission),
    };
    next();
  } catch (err) {
    next(err);
  }
}

export function requirePermission(...required: PermissionCode[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.authUser) {
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required.' },
      });
    }
    const hasAll = required.every((p) => req.authUser!.permissions.includes(p));
    if (!hasAll) {
      return res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: `Missing required permission: ${required.join(', ')}`,
        },
      });
    }
    next();
  };
}

export function requireSuperAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.authUser || req.authUser.role !== 'SUPER_ADMIN') {
    return res.status(403).json({
      error: {
        code: 'FORBIDDEN',
        message: 'This action requires Super Admin privileges.',
      },
    });
  }
  next();
}
