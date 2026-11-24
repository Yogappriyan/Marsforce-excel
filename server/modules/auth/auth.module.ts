import crypto from 'node:crypto';
import { Router } from 'express';
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
  resolveAuthorizedGoogleUser,
  SESSION_COOKIE_NAME,
  signAuthTokenAsync,
  verifyFirebaseIdToken,
  verifySignedAuthTokenAsync,
  type AuthenticatedRequest,
  type PermissionCode,
  type UserRole,
} from '../../middleware/security.ts';
import { emitAuditLog } from '../audit/audit.module.ts';

const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const REFRESH_TTL_MS = 180 * 24 * 60 * 60 * 1000;

export class AuthRepository {
  async findUserByEmail(email: string) {
    const db = getDb();
    const res = await db.query<{
      id: string;
      email: string;
      full_name: string;
      role: UserRole;
      is_active: boolean;
    }>(
      `SELECT id, email, full_name, role, is_active
       FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
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

  async ensureAuthorizedSuperAdmin(email: string, fullName: string) {
    const db = getDb();
    const normalized = email.trim().toLowerCase();
    const placeholderHash = hashToken(crypto.randomBytes(32).toString('hex'));
    await db.query(
      `INSERT INTO users (email, full_name, password_hash, role, is_active)
       VALUES ($1, $2, $3, 'SUPER_ADMIN', true)
       ON CONFLICT (email) DO UPDATE
         SET role = 'SUPER_ADMIN',
             is_active = true,
             failed_login_attempts = 0,
             locked_until = NULL,
             updated_at = NOW()`,
      [normalized, fullName, placeholderHash]
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

  async extendSession(sessionId: string) {
    const db = getDb();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    const refreshExpiresAt = new Date(Date.now() + REFRESH_TTL_MS);
    await db.query(
      'UPDATE sessions SET expires_at = $2, refresh_expires_at = $3 WHERE id = $1 AND revoked_at IS NULL',
      [sessionId, expiresAt, refreshExpiresAt]
    );
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
}

export class AuthService {
  private repo = new AuthRepository();

  async seedSuperAdminFromEnv(): Promise<void> {
    await this.repo.ensureAuthorizedSuperAdmin(env.authorizedGoogleEmail, 'Super Administrator');
    if (env.seedAdminEmail && env.seedAdminEmail !== env.authorizedGoogleEmail) {
      await this.repo.ensureAuthorizedSuperAdmin(env.seedAdminEmail, 'Workspace Administrator');
    }
  }

  async getAuthStatus() {
    return {
      needsInitialSetup: false,
      authDisabled: true,
      workspaceOpenAccess: true,
      vercelEphemeralWarning: env.isVercel && !env.databaseUrl && !env.hasExplicitSessionSecret,
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
    const sessionToken = await signAuthTokenAsync({
      typ: 'access',
      sid,
      uid: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      iat: now,
      exp: now + SESSION_TTL_MS,
    });
    const refreshToken = await signAuthTokenAsync({
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
}

export const authService = new AuthService();

export function createAuthRouter() {
  const router = Router();

  router.get('/status', async (_req, res, next) => {
    try {
      const status = await authService.getAuthStatus();
      res.json(status);
    } catch (err) {
      next(err);
    }
  });

  router.get('/me', requireAuth, (req: AuthenticatedRequest, res) => {
    res.json({ user: req.authUser });
  });

  return router;
}
