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

export interface SignedTokenPayload {
  typ: 'access' | 'refresh';
  sid: string;
  fid?: string;
  uid: string;
  email: string;
  fullName: string;
  role: UserRole;
  iat: number;
  exp: number;
}

let cachedDbSigningSecret: string | null = null;
let signingSecretPromise: Promise<string> | null = null;

export async function getSigningSecret(): Promise<string> {
  if (env.hasExplicitSessionSecret) {
    return env.sessionSecret;
  }
  if (cachedDbSigningSecret) {
    return cachedDbSigningSecret;
  }
  if (!signingSecretPromise) {
    signingSecretPromise = (async () => {
      try {
        const db = getDb();
        const generated = crypto.randomBytes(32).toString('hex');
        await db.query(
          `INSERT INTO settings (key, value, description)
           VALUES ('auth.signing_secret', $1::jsonb, 'Internal HMAC signing secret')
           ON CONFLICT (key) DO NOTHING`,
          [JSON.stringify(generated)]
        );
        const res = await db.query<{ value: unknown }>(
          `SELECT value FROM settings WHERE key = 'auth.signing_secret' LIMIT 1`
        );
        const val = res.rows[0]?.value;
        if (typeof val === 'string' && val.length >= 32) {
          cachedDbSigningSecret = val;
          return val;
        }
      } catch {
        // Fallback to process-scoped secret if DB is not ready yet
      }
      return env.sessionSecret;
    })().finally(() => {
      signingSecretPromise = null;
    });
  }
  return signingSecretPromise;
}

export function signAuthToken(payload: SignedTokenPayload, secret: string = env.sessionSecret): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `mf1.${encoded}.${sig}`;
}

export async function signAuthTokenAsync(payload: SignedTokenPayload): Promise<string> {
  const secret = await getSigningSecret();
  return signAuthToken(payload, secret);
}

export function verifySignedAuthToken(
  token: string | undefined,
  expectedType: 'access' | 'refresh',
  secret: string = env.sessionSecret
): SignedTokenPayload | null {
  if (!token || !token.startsWith('mf1.')) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [, encoded, providedSig] = parts;
  if (!encoded || !providedSig) return null;
  try {
    const expectedSig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
    const a = Buffer.from(providedSig, 'utf8');
    const b = Buffer.from(expectedSig, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return null;
    }
    const decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SignedTokenPayload;
    if (decoded.typ !== expectedType || !decoded.uid || !decoded.email || !decoded.exp) {
      return null;
    }
    if (decoded.exp <= Date.now()) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

export async function verifySignedAuthTokenAsync(
  token: string | undefined,
  expectedType: 'access' | 'refresh'
): Promise<SignedTokenPayload | null> {
  const secret = await getSigningSecret();
  return verifySignedAuthToken(token, expectedType, secret) ||
    (secret !== env.sessionSecret ? verifySignedAuthToken(token, expectedType, env.sessionSecret) : null);
}

export interface FirebaseIdTokenClaims {
  uid: string;
  email: string;
  fullName: string;
  emailVerified: boolean;
}

const GOOGLE_CERT_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
let cachedGoogleCerts: Record<string, string> = {};
let cachedCertsExpiresAt = 0;

async function getGooglePublicCerts(forceRefresh = false): Promise<Record<string, string>> {
  if (!forceRefresh && cachedCertsExpiresAt > Date.now() && Object.keys(cachedGoogleCerts).length > 0) {
    return cachedGoogleCerts;
  }
  const res = await fetch(GOOGLE_CERT_URL);
  if (!res.ok) {
    if (Object.keys(cachedGoogleCerts).length > 0) return cachedGoogleCerts;
    throw new Error(`Failed to fetch Google public certificates (${res.status})`);
  }
  const cc = res.headers.get('cache-control') || '';
  const maxAgeMatch = cc.match(/max-age=(\d+)/i);
  const ttlMs = maxAgeMatch ? Number(maxAgeMatch[1]) * 1000 : 3600_000;
  cachedGoogleCerts = (await res.json()) as Record<string, string>;
  cachedCertsExpiresAt = Date.now() + Math.max(60_000, ttlMs);
  return cachedGoogleCerts;
}

export async function verifyFirebaseIdToken(token: string | undefined): Promise<FirebaseIdTokenClaims | null> {
  if (!token || token.startsWith('mf1.') || !env.firebaseProjectId) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  if (!headerB64 || !payloadB64 || !sigB64) return null;

  try {
    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8')) as {
      alg?: string;
      kid?: string;
    };
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) {
      return null;
    }

    let certs = await getGooglePublicCerts(false);
    let certPem = certs[header.kid];
    if (!certPem) {
      certs = await getGooglePublicCerts(true);
      certPem = certs[header.kid];
    }
    if (!certPem) return null;

    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(`${headerB64}.${payloadB64}`);
    verifier.end();
    const signature = Buffer.from(sigB64, 'base64url');
    if (!verifier.verify(certPem, signature)) {
      return null;
    }

    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as {
      aud?: string;
      iss?: string;
      sub?: string;
      exp?: number;
      iat?: number;
      auth_time?: number;
      email?: string;
      email_verified?: boolean;
      name?: string;
    };

    const nowSec = Math.floor(Date.now() / 1000);
    const expectedIssuer = `https://securetoken.google.com/${env.firebaseProjectId}`;
    if (
      payload.aud !== env.firebaseProjectId ||
      payload.iss !== expectedIssuer ||
      typeof payload.sub !== 'string' ||
      payload.sub.length === 0 ||
      payload.sub.length > 128 ||
      typeof payload.exp !== 'number' ||
      payload.exp <= nowSec - 60 ||
      typeof payload.iat !== 'number' ||
      payload.iat > nowSec + 300 ||
      (typeof payload.auth_time === 'number' && payload.auth_time > nowSec + 300) ||
      payload.email_verified !== true ||
      typeof payload.email !== 'string' ||
      !payload.email.includes('@')
    ) {
      return null;
    }

    const normalizedEmail = payload.email.trim().toLowerCase();
    const fullName =
      typeof payload.name === 'string' && payload.name.trim().length >= 2
        ? payload.name.trim().slice(0, 120)
        : normalizedEmail.split('@')[0];

    return {
      uid: payload.sub,
      email: normalizedEmail,
      fullName,
      emailVerified: true,
    };
  } catch {
    return null;
  }
}

export async function resolveAuthorizedGoogleUser(claims: FirebaseIdTokenClaims): Promise<{
  authorized: true;
  user: {
    id: string;
    email: string;
    fullName: string;
    role: UserRole;
    isActive: boolean;
    permissions: PermissionCode[];
  };
} | {
  authorized: false;
  code: 'ACCESS_DENIED' | 'ACCOUNT_DISABLED';
  message: string;
}> {
  const db = getDb();
  const normalizedEmail = claims.email.trim().toLowerCase();
  const isPrimaryOwner =
    normalizedEmail === env.authorizedGoogleEmail ||
    (Boolean(env.seedAdminEmail) && normalizedEmail === env.seedAdminEmail);

  const existingRes = await db.query<{
    id: string;
    email: string;
    full_name: string;
    role: UserRole;
    is_active: boolean;
  }>(
    `SELECT id, email, full_name, role, is_active
     FROM users
     WHERE LOWER(email) = LOWER($1)
     LIMIT 1`,
    [normalizedEmail]
  );

  let userRow = existingRes.rows[0];

  if (!userRow && isPrimaryOwner) {
    const placeholderHash = hashToken(crypto.randomBytes(32).toString('hex'));
    const ins = await db.query<{
      id: string;
      email: string;
      full_name: string;
      role: UserRole;
      is_active: boolean;
    }>(
      `INSERT INTO users (email, full_name, password_hash, role, is_active, last_login_at)
       VALUES ($1, $2, $3, 'SUPER_ADMIN', true, NOW())
       ON CONFLICT (email) DO UPDATE
         SET role = 'SUPER_ADMIN',
             is_active = true,
             last_login_at = NOW(),
             updated_at = NOW()
       RETURNING id, email, full_name, role, is_active`,
      [normalizedEmail, claims.fullName || 'Super Administrator', placeholderHash]
    );
    userRow = ins.rows[0];
  } else if (userRow && isPrimaryOwner && (userRow.role !== 'SUPER_ADMIN' || !userRow.is_active)) {
    const upd = await db.query<{
      id: string;
      email: string;
      full_name: string;
      role: UserRole;
      is_active: boolean;
    }>(
      `UPDATE users
       SET role = 'SUPER_ADMIN', is_active = true, updated_at = NOW()
       WHERE id = $1
       RETURNING id, email, full_name, role, is_active`,
      [userRow.id]
    );
    userRow = upd.rows[0];
  }

  if (!userRow) {
    return {
      authorized: false,
      code: 'ACCESS_DENIED',
      message: `Access restricted: "${normalizedEmail}" is not authorized. Continue with ${env.authorizedGoogleEmail} or ask an administrator to authorize your Google email.`,
    };
  }

  if (!userRow.is_active) {
    return {
      authorized: false,
      code: 'ACCOUNT_DISABLED',
      message: `Your workspace account (${normalizedEmail}) has been deactivated.`,
    };
  }

  const permsRes = await db.query<{ permission: PermissionCode }>(
    `SELECT permission FROM role_permissions WHERE role = $1`,
    [userRow.role]
  );

  return {
    authorized: true,
    user: {
      id: userRow.id,
      email: userRow.email,
      fullName: userRow.full_name,
      role: userRow.role,
      isActive: userRow.is_active,
      permissions: permsRes.rows.map((r) => r.permission),
    },
  };
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
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many authentication attempts. Please try again shortly.',
    },
  },
});

export const uploadRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
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
  max: 1200,
  skip: (req) => req.path.startsWith('/auth/'),
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

  const normalizeLocalLoopback = (host: string) => host.replace(/^127\.0\.0\.1(?=:|$)/, 'localhost');
  if (
    parsedSource.host === expectedHost ||
    normalizeLocalLoopback(parsedSource.host) === normalizeLocalLoopback(expectedHost) ||
    allowedOrigins.has(parsedSource.origin)
  ) {
    return next();
  }

  return res.status(403).json({
    error: {
      code: 'CSRF_ORIGIN_MISMATCH',
      message: 'Cross-site mutating request rejected due to origin mismatch.',
    },
  });
}

let cachedWorkspaceUser: AuthUser | null = null;
let workspaceUserPromise: Promise<AuthUser> | null = null;

export async function resolveOpenWorkspaceUser(): Promise<AuthUser> {
  if (cachedWorkspaceUser) {
    return cachedWorkspaceUser;
  }
  if (!workspaceUserPromise) {
    workspaceUserPromise = (async () => {
      const db = getDb();
      const targetEmail = env.authorizedGoogleEmail || 'workspace@marsforce.local';
      let userRowRes = await db.query<{
        id: string;
        email: string;
        full_name: string;
        role: UserRole;
        is_active: boolean;
      }>(
        `SELECT id, email, full_name, role, is_active
         FROM users
         WHERE is_active = true
         ORDER BY CASE WHEN LOWER(email) = LOWER($1) THEN 0 WHEN role = 'SUPER_ADMIN' THEN 1 ELSE 2 END, created_at ASC
         LIMIT 1`,
        [targetEmail]
      );

      let userRow = userRowRes.rows[0];
      if (!userRow) {
        const placeholderHash = hashToken(crypto.randomBytes(32).toString('hex'));
        const inserted = await db.query<{
          id: string;
          email: string;
          full_name: string;
          role: UserRole;
          is_active: boolean;
        }>(
          `INSERT INTO users (email, full_name, password_hash, role, is_active, last_login_at)
           VALUES ($1, 'MARSFORCE Operator', $2, 'SUPER_ADMIN', true, NOW())
           ON CONFLICT (email) DO UPDATE
             SET role = 'SUPER_ADMIN',
                 is_active = true,
                 updated_at = NOW()
           RETURNING id, email, full_name, role, is_active`,
          [targetEmail, placeholderHash]
        );
        userRow = inserted.rows[0];
      }

      const permsRes = await db.query<{ permission: PermissionCode }>(
        `SELECT permission FROM role_permissions WHERE role = $1`,
        [userRow.role]
      );

      const resolved: AuthUser = {
        id: userRow.id,
        email: userRow.email,
        fullName: userRow.full_name,
        role: userRow.role,
        isActive: userRow.is_active,
        permissions: permsRes.rows.map((r) => r.permission),
      };
      cachedWorkspaceUser = resolved;
      return resolved;
    })().finally(() => {
      workspaceUserPromise = null;
    });
  }
  return workspaceUserPromise;
}

export async function requireAuth(req: AuthenticatedRequest, _res: Response, next: NextFunction) {
  try {
    req.authUser = await resolveOpenWorkspaceUser();
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
