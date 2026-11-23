import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../infrastructure/db/index.ts';
import {
  requireAuth,
  requirePermission,
  validateBody,
  validateUuidParams,
  type AuthenticatedRequest,
  type UserRole,
} from '../../middleware/security.ts';
import { emitAuditLog } from '../audit/audit.module.ts';
import { PasswordPolicySchema } from '../auth/auth.module.ts';

const RoleEnum = z.enum(['SUPER_ADMIN', 'ADMIN', 'DATA_PROCESSOR', 'REVIEWER', 'READ_ONLY']);

const CreateUserSchema = z.object({
  email: z.string().email().max(254),
  fullName: z.string().trim().min(2).max(120),
  password: PasswordPolicySchema,
  role: RoleEnum,
});

const UpdateUserSchema = z.object({
  fullName: z.string().trim().min(2).max(120).optional(),
  role: RoleEnum.optional(),
  isActive: z.boolean().optional(),
  unlockAccount: z.boolean().optional(),
});

const ResetPasswordSchema = z.object({
  newPassword: PasswordPolicySchema,
});

const ListUsersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().max(120).optional(),
  role: RoleEnum.optional(),
  isActive: z.enum(['true', 'false']).optional(),
});

export class UsersRepository {
  async list(filters: z.infer<typeof ListUsersQuerySchema>) {
    const db = getDb();
    const conds: string[] = [];
    const params: unknown[] = [];

    if (filters.search) {
      params.push(`%${filters.search.trim()}%`);
      conds.push(`(email ILIKE $${params.length} OR full_name ILIKE $${params.length})`);
    }
    if (filters.role) {
      params.push(filters.role);
      conds.push(`role = $${params.length}`);
    }
    if (filters.isActive !== undefined) {
      params.push(filters.isActive === 'true');
      conds.push(`is_active = $${params.length}`);
    }

    const whereClause = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const countRes = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM users ${whereClause}`,
      params
    );
    const total = Number(countRes.rows[0]?.count || 0);
    const offset = (filters.page - 1) * filters.pageSize;
    params.push(filters.pageSize, offset);

    const rowsRes = await db.query(
      `SELECT id, email, full_name, role, is_active, failed_login_attempts, locked_until, last_login_at, created_at
       FROM users ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return { items: rowsRes.rows, total };
  }

  async findById(id: string) {
    const db = getDb();
    const res = await db.query<{
      id: string;
      email: string;
      full_name: string;
      role: UserRole;
      is_active: boolean;
    }>('SELECT id, email, full_name, role, is_active FROM users WHERE id = $1', [id]);
    return res.rows[0] || null;
  }

  async create(params: {
    email: string;
    fullName: string;
    passwordHash: string;
    role: UserRole;
    createdBy: string;
  }) {
    const db = getDb();
    const res = await db.query(
      `INSERT INTO users (email, full_name, password_hash, role, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, full_name, role, is_active, created_at`,
      [params.email.trim().toLowerCase(), params.fullName.trim(), params.passwordHash, params.role, params.createdBy]
    );
    return res.rows[0];
  }

  async update(
    id: string,
    patch: { fullName?: string; role?: UserRole; isActive?: boolean; unlockAccount?: boolean }
  ) {
    const db = getDb();
    const sets: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [id];

    if (patch.fullName !== undefined) {
      params.push(patch.fullName.trim());
      sets.push(`full_name = $${params.length}`);
    }
    if (patch.role !== undefined) {
      params.push(patch.role);
      sets.push(`role = $${params.length}`);
    }
    if (patch.isActive !== undefined) {
      params.push(patch.isActive);
      sets.push(`is_active = $${params.length}`);
    }
    if (patch.unlockAccount) {
      sets.push('failed_login_attempts = 0, locked_until = NULL');
    }

    const res = await db.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $1
       RETURNING id, email, full_name, role, is_active, failed_login_attempts, locked_until, last_login_at, created_at`,
      params
    );
    if (patch.isActive === false) {
      await db.query('UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
    }
    return res.rows[0];
  }

  async resetPassword(id: string, passwordHash: string) {
    const db = getDb();
    await db.query(
      `UPDATE users SET password_hash = $2, password_changed_at = NOW(), failed_login_attempts = 0, locked_until = NULL, updated_at = NOW() WHERE id = $1`,
      [id, passwordHash]
    );
    await db.query('UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
  }
}

export function createUsersRouter() {
  const router = Router();
  const repo = new UsersRepository();
  router.use(requireAuth, requirePermission('manage_users'));

  router.get('/', async (req, res, next) => {
    try {
      const q = ListUsersQuerySchema.parse(req.query);
      const data = await repo.list(q);
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  router.post('/', validateBody(CreateUserSchema), async (req: AuthenticatedRequest, res, next) => {
    try {
      const body = req.body as z.infer<typeof CreateUserSchema>;
      if (body.role === 'SUPER_ADMIN' && req.authUser!.role !== 'SUPER_ADMIN') {
        return res.status(403).json({
          error: { code: 'FORBIDDEN', message: 'Only Super Admins can create Super Admin accounts.' },
        });
      }
      const hash = await bcrypt.hash(body.password, 12);
      const user = await repo.create({
        email: body.email,
        fullName: body.fullName,
        passwordHash: hash,
        role: body.role,
        createdBy: req.authUser!.id,
      });
      await emitAuditLog({
        actorId: req.authUser!.id,
        actorRole: req.authUser!.role,
        action: 'USER_CREATE',
        resourceType: 'user',
        resourceId: user.id,
        req,
        metadata: { assignedRole: body.role },
      });
      res.status(201).json({ user });
    } catch (err: any) {
      if (err?.code === '23505') {
        return res.status(409).json({ error: { code: 'DUPLICATE_EMAIL', message: 'A user with this email already exists.' } });
      }
      next(err);
    }
  });

  router.patch('/:id', validateUuidParams('id'), validateBody(UpdateUserSchema), async (req: AuthenticatedRequest, res, next) => {
    try {
      const id = String(req.params.id);
      const target = await repo.findById(id);
      if (!target) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
      }
      const body = req.body as z.infer<typeof UpdateUserSchema>;

      if (
        (target.role === 'SUPER_ADMIN' || body.role === 'SUPER_ADMIN') &&
        req.authUser!.role !== 'SUPER_ADMIN'
      ) {
        return res.status(403).json({
          error: { code: 'FORBIDDEN', message: 'Admins cannot modify or elevate Super Admin accounts.' },
        });
      }
      if (id === req.authUser!.id && body.isActive === false) {
        return res.status(400).json({
          error: { code: 'SELF_DEACTIVATION_BLOCKED', message: 'You cannot deactivate your own active account.' },
        });
      }

      const updated = await repo.update(id, body);
      await emitAuditLog({
        actorId: req.authUser!.id,
        actorRole: req.authUser!.role,
        action: 'USER_UPDATE',
        resourceType: 'user',
        resourceId: id,
        req,
        metadata: { changedKeys: Object.keys(body) },
      });
      res.json({ user: updated });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/reset-password', validateUuidParams('id'), validateBody(ResetPasswordSchema), async (req: AuthenticatedRequest, res, next) => {
    try {
      const id = String(req.params.id);
      const target = await repo.findById(id);
      if (!target) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
      }
      if (target.role === 'SUPER_ADMIN' && req.authUser!.role !== 'SUPER_ADMIN') {
        return res.status(403).json({
          error: { code: 'FORBIDDEN', message: 'Admins cannot reset Super Admin passwords.' },
        });
      }
      const hash = await bcrypt.hash(req.body.newPassword, 12);
      await repo.resetPassword(id, hash);
      await emitAuditLog({
        actorId: req.authUser!.id,
        actorRole: req.authUser!.role,
        action: 'USER_PASSWORD_RESET',
        resourceType: 'user',
        resourceId: id,
        req,
      });
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
