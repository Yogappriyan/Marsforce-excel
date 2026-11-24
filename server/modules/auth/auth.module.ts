import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.ts';
import { getDb } from '../../infrastructure/db/index.ts';
import {
  getClearCookieOptions,
  getCookieOptions,
  hashToken,
  LEGACY_REFRESH_COOKIE_NAME,
  LEGACY_SESSION_COOKIE_NAME,
  loginRateLimiter,
  REFRESH_COOKIE_NAME,
  requireAuth,
  SESSION_COOKIE_NAME,
  signAuthToken,
  validateBody,
  verifySignedAuthToken,
  type AuthenticatedRequest,
  type PermissionCode,
  type UserRole,
} from '../../middleware/security.ts';
import { emitAuditLog } from '../audit/audit.module.ts';

export const PasswordPolicySchema = z
  .string()
  .min(6, 'Password must be at least 6 characters long.')
  .max(128);

const LoginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128),
});

const SetupAdminSchema = z.object({
  email: z.string().email().max(254),
  fullName: z.string().trim().min(2).max(120),
  password: PasswordPolicySchema,
});

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: PasswordPolicySchema,
});

const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const REFRESH_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 25;
const LOCKOUT_MINUTES = 2;
const DUMMY_BCRYPT_HASH = '$2b$12$C6UzMDM.H6dfI/f/IKxGhu6/7fJQXE3w7sY8bJ6y6vV6w1J2Q6k8e';

export class AuthRepository {
  async countUsers(): Promise<number> {
    const db = getDb();
    const res = await db.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM users');
    return Number(res.rows[0]?.count || 0);
  }

  async findUserByEmail(email: string) {
    const db = getDb();
    const res = await db.query<{
      id: string;
      email: string;
      full_name: string;
      password_hash: string;
      role: UserRole;
      is_active: boolean;
      failed_login_attempts: number;
      locked_until: Date | string | null;
    }>(
      `SELECT id, email, full_name, password_hash, role, is_active, failed_login_attempts, locked_until
       FROM users WHERE email = $1 LIMIT 1`,
      [email.trim().toLowerCase()]
    );
    return res.rows[0] || null;
  }

  async getPermissionsForRole(role: UserRole): Promise<PermissionCode[]> {
    const db = getDb();
    const res = await db.query<{ permission: PermissionCode }>(
      'SELECT permission FROM role_permissions WHERE role = $1',
      [role]
    );
    return res.rows.map((r) => r.permission);
  }

  async createUser(params: { email: string; fullName: string; passwordHash: string; role: UserRole }) {
    const db = getDb();
    const res = await db.query<{
      id: string;
      email: string;
      full_name: string;
      role: UserRole;
      is_active: boolean;
    }>(
      `INSERT INTO users (email, full_name, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, full_name, role, is_active`,
      [params.email.trim().toLowerCase(), params.fullName.trim(), params.passwordHash, params.role]
    );
    return res.rows[0];
  }

  async recordFailedLogin(userId: string, attempts: number, lockedUntil: Date | null) {
    const db = getDb();
    await db.query(
      `UPDATE users SET failed_login_attempts = $2, locked_until = $3, updated_at = NOW() WHERE id = $1`,
      [userId, attempts, lockedUntil]
    );
  }

  async recordSuccessfulLogin(userId: string) {
    const db = getDb();
    await db.query(
      `UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [userId]
    );
  }

  async createSession(params: {
    userId: string;
    sessionTokenHash: string;
    refreshTokenHash: string;
    tokenFamilyId: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  }) {
    const db = getDb();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    const refreshExpiresAt = new Date(Date.now() + REFRESH_TTL_MS);
    const res = await db.query<{ id: string }>(
      `INSERT INTO sessions (user_id, session_token_hash, refresh_token_hash, token_family_id, ip_address, user_agent, expires_at, refresh_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        params.userId,
        params.sessionTokenHash,
        params.refreshTokenHash,
        params.tokenFamilyId,
        params.ipAddress || null,
        params.userAgent || null,
        expiresAt,
        refreshExpiresAt,
      ]
    );
    return res.rows[0].id;
  }

  async findSessionByRefreshHash(refreshHash: string) {
    const db = getDb();
    const res = await db.query<{
      id: string;
      user_id: string;
      token_family_id: string;
      revoked_at: Date | string | null;
      refresh_expires_at: Date | string;
      email: string;
      full_name: string;
      role: UserRole;
      is_active: boolean;
    }>(
      `SELECT s.id, s.user_id, s.token_family_id, s.revoked_at, s.refresh_expires_at,
              u.email, u.full_name, u.role, u.is_active
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.refresh_token_hash = $1
       LIMIT 1`,
      [refreshHash]
    );
    return res.rows[0] || null;
  }

  async revokeSession(sessionId: string) {
    const db = getDb();
    await db.query('UPDATE sessions SET revoked_at = NOW() WHERE id = $1', [sessionId]);
  }

  async hasActiveSiblingSession(familyId: string): Promise<boolean> {
    const db = getDb();
    const res = await db.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM sessions
         WHERE token_family_id = $1 AND revoked_at IS NULL AND refresh_expires_at > NOW()
       ) AS exists`,
      [familyId]
    );
    return Boolean(res.rows[0]?.exists);
  }

  async revokeTokenFamily(familyId: string) {
    const db = getDb();
    await db.query('UPDATE sessions SET revoked_at = NOW() WHERE token_family_id = $1 AND revoked_at IS NULL', [
      familyId,
    ]);
  }

  async updatePassword(userId: string, passwordHash: string) {
    const db = getDb();
    await db.query(
      `UPDATE users SET password_hash = $2, password_changed_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [userId, passwordHash]
    );
  }
}

export class AuthService {
  private repo = new AuthRepository();

  async seedSuperAdminFromEnv(): Promise<void> {
    if (!env.seedAdminEmail || !env.seedAdminPassword) return;
    const existing = await this.repo.findUserByEmail(env.seedAdminEmail);
    if (existing) {
      const passwordMatches = await bcrypt.compare(env.seedAdminPassword, existing.password_hash);
      if (
        !passwordMatches ||
        existing.role !== 'SUPER_ADMIN' ||
        !existing.is_active ||
        existing.failed_login_attempts > 0 ||
        existing.locked_until
      ) {
        const db = getDb();
        const nextHash = passwordMatches ? existing.password_hash : await bcrypt.hash(env.seedAdminPassword, 12);
        await db.query(
          `UPDATE users
           SET password_hash = $2,
               role = 'SUPER_ADMIN',
               is_active = true,
               failed_login_attempts = 0,
               locked_until = NULL,
               updated_at = NOW()
           WHERE id = $1`,
          [existing.id, nextHash]
        );
        console.log('[Auth] Synced Super Admin credentials from SEED_ADMIN_EMAIL secret.');
      }
      return;
    }

    const hash = await bcrypt.hash(env.seedAdminPassword, 12);
    await this.repo.createUser({
      email: env.seedAdminEmail,
      fullName: 'Super Administrator',
      passwordHash: hash,
      role: 'SUPER_ADMIN',
    });
    console.log('[Auth] Seeded initial Super Admin from SEED_ADMIN_EMAIL secret.');
  }

  async getAuthStatus() {
    const count = await this.repo.countUsers();
    return { needsInitialSetup: count === 0 };
  }

  async setupInitialSuperAdmin(input: z.infer<typeof SetupAdminSchema>, req: AuthenticatedRequest) {
    const count = await this.repo.countUsers();
    if (count > 0) {
      return { status: 409 as const, code: 'ALREADY_INITIALIZED', message: 'Workspace already has an administrator.' };
    }
    const hash = await bcrypt.hash(input.password, 12);
    const user = await this.repo.createUser({
      email: input.email,
      fullName: input.fullName,
      passwordHash: hash,
      role: 'SUPER_ADMIN',
    });
    const sessionTokens = await this.issueSessionTokens(
      { id: user.id, email: user.email, fullName: user.full_name, role: user.role },
      req
    );
    const permissions = await this.repo.getPermissionsForRole(user.role);
    await emitAuditLog({
      actorId: user.id,
      actorRole: user.role,
      action: 'AUTH_INITIAL_SETUP',
      resourceType: 'user',
      resourceId: user.id,
      req,
    });
    return {
      status: 201 as const,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        role: user.role,
        isActive: user.is_active,
        permissions,
      },
      ...sessionTokens,
    };
  }

  private async issueSessionTokens(
    user: { id: string; email: string; fullName: string; role: UserRole },
    req: AuthenticatedRequest,
    existingFamilyId?: string
  ) {
    const sid = crypto.randomUUID();
    const familyId = existingFamilyId || crypto.randomUUID();
    const now = Date.now();
    const sessionToken = signAuthToken({
      typ: 'access',
      sid,
      uid: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      iat: now,
      exp: now + SESSION_TTL_MS,
    });
    const refreshToken = signAuthToken({
      typ: 'refresh',
      sid,
      fid: familyId,
      uid: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      iat: now,
      exp: now + REFRESH_TTL_MS,
    });
    const ua = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 300) : null;

    await this.repo.createSession({
      userId: user.id,
      sessionTokenHash: hashToken(sessionToken),
      refreshTokenHash: hashToken(refreshToken),
      tokenFamilyId: familyId,
      ipAddress: req.ip || null,
      userAgent: ua,
    });

    return { sessionToken, refreshToken };
  }

  async login(input: z.infer<typeof LoginSchema>, req: AuthenticatedRequest) {
    const user = await this.repo.findUserByEmail(input.email);
    if (!user) {
      await bcrypt.compare(input.password, DUMMY_BCRYPT_HASH);
      await emitAuditLog({
        action: 'AUTH_LOGIN_FAIL',
        resourceType: 'session',
        req,
        metadata: { reason: 'UNKNOWN_ACCOUNT' },
      });
      return { status: 401 as const, code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' };
    }

    if (!user.is_active) {
      return { status: 403 as const, code: 'ACCOUNT_DISABLED', message: 'This account has been deactivated.' };
    }

    const lockTimeMs = user.locked_until ? new Date(user.locked_until).getTime() : 0;
    if (lockTimeMs > Date.now()) {
      const retryMins = Math.ceil((lockTimeMs - Date.now()) / 60000);
      return {
        status: 423 as const,
        code: 'ACCOUNT_LOCKED',
        message: `Account temporarily locked due to failed attempts. Try again in ${retryMins} minute(s).`,
      };
    }

    const effectiveFailedAttempts = user.locked_until ? 0 : user.failed_login_attempts;

    const match = await bcrypt.compare(input.password, user.password_hash);
    if (!match) {
      const nextAttempts = effectiveFailedAttempts + 1;
      const shouldLock = nextAttempts >= MAX_FAILED_ATTEMPTS;
      const lockedUntil = shouldLock ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000) : null;
      await this.repo.recordFailedLogin(user.id, nextAttempts, lockedUntil);
      await emitAuditLog({
        actorId: user.id,
        actorRole: user.role,
        action: shouldLock ? 'AUTH_LOCKOUT' : 'AUTH_LOGIN_FAIL',
        resourceType: 'user',
        resourceId: user.id,
        req,
        metadata: { attempt: nextAttempts },
      });
      return {
        status: shouldLock ? (423 as const) : (401 as const),
        code: shouldLock ? 'ACCOUNT_LOCKED' : 'INVALID_CREDENTIALS',
        message: shouldLock
          ? `Account locked for ${LOCKOUT_MINUTES} minutes after ${MAX_FAILED_ATTEMPTS} failed login attempts.`
          : 'Invalid email or password.',
      };
    }

    await this.repo.recordSuccessfulLogin(user.id);
    const tokens = await this.issueSessionTokens(
      { id: user.id, email: user.email, fullName: user.full_name, role: user.role },
      req
    );
    const permissions = await this.repo.getPermissionsForRole(user.role);
    await emitAuditLog({
      actorId: user.id,
      actorRole: user.role,
      action: 'AUTH_LOGIN_SUCCESS',
      resourceType: 'session',
      resourceId: user.id,
      req,
    });

    return {
      status: 200 as const,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        role: user.role,
        isActive: user.is_active,
        permissions,
      },
      ...tokens,
    };
  }

  async refresh(refreshToken: string, req: AuthenticatedRequest) {
    const row = await this.repo.findSessionByRefreshHash(hashToken(refreshToken));
    if (!row) {
      // Serverless /tmp DB fallback: verify HMAC-signed refresh token if DB row wasn't persisted here
      const signed = verifySignedAuthToken(refreshToken, 'refresh');
      if (!signed) {
        return { status: 401 as const, code: 'INVALID_REFRESH', message: 'Refresh token invalid.' };
      }
      let user = await this.repo.findUserByEmail(signed.email);
      if (!user && env.isVercel && !env.databaseUrl) {
        const db = getDb();
        const placeholderHash = hashToken(crypto.randomBytes(32).toString('hex'));
        await db.query(
          `INSERT INTO users (id, email, full_name, password_hash, role)
           VALUES ($1, $2, $3, $4, $5::user_role)
           ON CONFLICT (email) DO UPDATE SET updated_at = NOW()`,
          [signed.uid, signed.email.toLowerCase(), signed.fullName, placeholderHash, signed.role]
        );
        user = await this.repo.findUserByEmail(signed.email);
      }
      if (!user || !user.is_active) {
        return { status: 401 as const, code: 'INVALID_REFRESH', message: 'Refresh token invalid.' };
      }
      const tokens = await this.issueSessionTokens(
        { id: user.id, email: user.email, fullName: user.full_name, role: user.role },
        req,
        signed.fid
      );
      const permissions = await this.repo.getPermissionsForRole(user.role);
      return {
        status: 200 as const,
        user: {
          id: user.id,
          email: user.email,
          fullName: user.full_name,
          role: user.role,
          isActive: user.is_active,
          permissions,
        },
        ...tokens,
      };
    }

    if (row.revoked_at) {
      const revokedAgoMs = Date.now() - new Date(row.revoked_at).getTime();
      const withinGraceWindow =
        revokedAgoMs >= 0 &&
        revokedAgoMs <= 30_000 &&
        row.is_active &&
        new Date(row.refresh_expires_at).getTime() > Date.now() &&
        (await this.repo.hasActiveSiblingSession(row.token_family_id));
      if (!withinGraceWindow) {
        return { status: 401 as const, code: 'INVALID_REFRESH', message: 'Refresh token already rotated.' };
      }
    } else if (!row.is_active || new Date(row.refresh_expires_at).getTime() <= Date.now()) {
      await this.repo.revokeSession(row.id);
      return { status: 401 as const, code: 'REFRESH_EXPIRED', message: 'Session expired. Please sign in.' };
    } else {
      await this.repo.revokeSession(row.id);
    }
    const tokens = await this.issueSessionTokens(
      { id: row.user_id, email: row.email, fullName: row.full_name, role: row.role },
      req,
      row.token_family_id
    );
    const permissions = await this.repo.getPermissionsForRole(row.role);

    return {
      status: 200 as const,
      user: {
        id: row.user_id,
        email: row.email,
        fullName: row.full_name,
        role: row.role,
        isActive: row.is_active,
        permissions,
      },
      ...tokens,
    };
  }

  async changePassword(userId: string, email: string, role: UserRole, input: z.infer<typeof ChangePasswordSchema>, req: AuthenticatedRequest) {
    const user = await this.repo.findUserByEmail(email);
    if (!user) {
      return { status: 404 as const, code: 'NOT_FOUND', message: 'User not found.' };
    }
    const ok = await bcrypt.compare(input.currentPassword, user.password_hash);
    if (!ok) {
      return { status: 400 as const, code: 'INVALID_PASSWORD', message: 'Current password is incorrect.' };
    }
    const hash = await bcrypt.hash(input.newPassword, 12);
    await this.repo.updatePassword(userId, hash);
    await emitAuditLog({
      actorId: userId,
      actorRole: role,
      action: 'AUTH_PASSWORD_CHANGE',
      resourceType: 'user',
      resourceId: userId,
      req,
    });
    return { status: 200 as const };
  }
}

export const authService = new AuthService();

export function createAuthRouter() {
  const router = Router();
  const repo = new AuthRepository();

  router.get('/status', async (_req, res, next) => {
    try {
      const status = await authService.getAuthStatus();
      res.json(status);
    } catch (err) {
      next(err);
    }
  });

  router.post('/setup', loginRateLimiter, validateBody(SetupAdminSchema), async (req: AuthenticatedRequest, res, next) => {
    try {
      const result = await authService.setupInitialSuperAdmin(req.body, req);
      if ('code' in result) {
        return res.status(result.status).json({ error: { code: result.code, message: result.message } });
      }
      res.cookie(SESSION_COOKIE_NAME, result.sessionToken, getCookieOptions(req, SESSION_TTL_MS));
      res.cookie(REFRESH_COOKIE_NAME, result.refreshToken, getCookieOptions(req, REFRESH_TTL_MS));
      res.status(201).json({
        user: result.user,
        accessToken: result.sessionToken,
        refreshToken: result.refreshToken,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/login', loginRateLimiter, validateBody(LoginSchema), async (req: AuthenticatedRequest, res, next) => {
    try {
      const result = await authService.login(req.body, req);
      if ('code' in result) {
        return res.status(result.status).json({ error: { code: result.code, message: result.message } });
      }
      res.cookie(SESSION_COOKIE_NAME, result.sessionToken, getCookieOptions(req, SESSION_TTL_MS));
      res.cookie(REFRESH_COOKIE_NAME, result.refreshToken, getCookieOptions(req, REFRESH_TTL_MS));
      res.json({
        user: result.user,
        accessToken: result.sessionToken,
        refreshToken: result.refreshToken,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/refresh', async (req: AuthenticatedRequest, res, next) => {
    try {
      const primaryRefresh =
        typeof req.cookies?.[REFRESH_COOKIE_NAME] === 'string' && req.cookies[REFRESH_COOKIE_NAME].length > 0
          ? req.cookies[REFRESH_COOKIE_NAME]
          : undefined;
      const legacyRefresh =
        typeof req.cookies?.[LEGACY_REFRESH_COOKIE_NAME] === 'string' && req.cookies[LEGACY_REFRESH_COOKIE_NAME].length > 0
          ? req.cookies[LEGACY_REFRESH_COOKIE_NAME]
          : undefined;
      const cookieRefresh = primaryRefresh || legacyRefresh;
      const bodyRefresh =
        typeof req.body?.refreshToken === 'string' && req.body.refreshToken.length > 0
          ? req.body.refreshToken
          : undefined;
      const candidates = Array.from(new Set([bodyRefresh, cookieRefresh].filter((t): t is string => Boolean(t))));
      if (candidates.length === 0) {
        return res.status(401).json({ error: { code: 'NO_REFRESH_TOKEN', message: 'Missing refresh token.' } });
      }

      let result: Awaited<ReturnType<typeof authService.refresh>> | null = null;
      for (const cand of candidates) {
        const attempt = await authService.refresh(cand, req);
        result = attempt;
        if (!('code' in attempt)) {
          break;
        }
      }

      if (!result || 'code' in result) {
        const clearOpts = getClearCookieOptions(req);
        res.clearCookie(SESSION_COOKIE_NAME, clearOpts);
        res.clearCookie(REFRESH_COOKIE_NAME, clearOpts);
        res.clearCookie(LEGACY_SESSION_COOKIE_NAME, clearOpts);
        res.clearCookie(LEGACY_REFRESH_COOKIE_NAME, clearOpts);
        return res.status(result?.status || 401).json({
          error: {
            code: result && 'code' in result ? result.code : 'INVALID_REFRESH',
            message: result && 'code' in result ? result.message : 'Refresh token invalid.',
          },
        });
      }
      const clearOpts = getClearCookieOptions(req);
      res.clearCookie(LEGACY_SESSION_COOKIE_NAME, clearOpts);
      res.clearCookie(LEGACY_REFRESH_COOKIE_NAME, clearOpts);
      res.cookie(SESSION_COOKIE_NAME, result.sessionToken, getCookieOptions(req, SESSION_TTL_MS));
      res.cookie(REFRESH_COOKIE_NAME, result.refreshToken, getCookieOptions(req, REFRESH_TTL_MS));
      res.json({
        user: result.user,
        accessToken: result.sessionToken,
        refreshToken: result.refreshToken,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (req.sessionId) {
        await repo.revokeSession(req.sessionId);
      }
      await emitAuditLog({
        actorId: req.authUser?.id,
        actorRole: req.authUser?.role,
        action: 'AUTH_LOGOUT',
        resourceType: 'session',
        resourceId: req.sessionId,
        req,
      });
      const clearOpts = getClearCookieOptions(req);
      res.clearCookie(SESSION_COOKIE_NAME, clearOpts);
      res.clearCookie(REFRESH_COOKIE_NAME, clearOpts);
      res.clearCookie(LEGACY_SESSION_COOKIE_NAME, clearOpts);
      res.clearCookie(LEGACY_REFRESH_COOKIE_NAME, clearOpts);
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  router.get('/me', requireAuth, (req: AuthenticatedRequest, res) => {
    res.json({ user: req.authUser });
  });

  router.post('/change-password', requireAuth, validateBody(ChangePasswordSchema), async (req: AuthenticatedRequest, res, next) => {
    try {
      const result = await authService.changePassword(
        req.authUser!.id,
        req.authUser!.email,
        req.authUser!.role,
        req.body,
        req
      );
      if ('code' in result) {
        return res.status(result.status).json({ error: { code: result.code, message: result.message } });
      }
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
