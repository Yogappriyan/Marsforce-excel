import { Router } from 'express';
import { z } from 'zod';
import { getDb, type DbSession } from '../../infrastructure/db/index.ts';
import {
  isValidUuid,
  requireAuth,
  requirePermission,
  validateBody,
  validateUuidParams,
  type AuthenticatedRequest,
} from '../../middleware/security.ts';
import { emitAuditLog } from '../audit/audit.module.ts';

const ConditionClauseSchema = z.object({
  field: z.enum(['full_name', 'street', 'area', 'city', 'district', 'state', 'pin_code', 'phone_e164', 'other_fields']),
  matchType: z.enum(['EQUALS', 'CONTAINS', 'REGEX', 'IN']),
  value: z.string().min(1).max(500),
});

const CategoryRuleSchema = z.object({
  name: z.string().trim().min(2).max(120),
  priority: z.number().int().min(1).max(10000).default(100),
  categoryType: z.enum([
    'LOCATION_STATE',
    'LOCATION_DISTRICT',
    'LOCATION_CITY',
    'LOCATION_STREET',
    'CUSTOMER_TYPE',
    'BUSINESS_CATEGORY',
    'CUSTOM',
  ]),
  categoryValue: z.string().trim().min(1).max(120),
  parentRuleId: z.string().uuid().nullable().optional(),
  conditions: z.object({
    operator: z.enum(['AND', 'OR']).default('AND'),
    clauses: z.array(ConditionClauseSchema).min(1),
  }),
  isActive: z.boolean().default(true),
});

export interface CategoryRuleRow {
  id: string;
  name: string;
  priority: number;
  category_type: string;
  category_value: string;
  parent_rule_id: string | null;
  conditions: {
    operator: 'AND' | 'OR';
    clauses: Array<{ field: string; matchType: 'EQUALS' | 'CONTAINS' | 'REGEX' | 'IN'; value: string }>;
  };
  is_active: boolean;
}

export interface CategorisableRecord {
  id: string;
  full_name: string | null;
  street: string | null;
  street_group?: string | null;
  sub_area?: string | null;
  area: string | null;
  city: string | null;
  district: string | null;
  state: string | null;
  pin_code: string | null;
  phone_e164: string | null;
  other_fields: Record<string, unknown>;
}

function evaluateClause(
  record: CategorisableRecord,
  clause: { field: string; matchType: string; value: string }
): boolean {
  let raw = '';
  if (clause.field === 'other_fields') {
    raw = JSON.stringify(record.other_fields || {});
  } else {
    raw = String((record as unknown as Record<string, unknown>)[clause.field] ?? '');
  }
  const haystack = raw.trim().toLowerCase();
  const needle = clause.value.trim().toLowerCase();
  if (!haystack) return false;

  switch (clause.matchType) {
    case 'EQUALS':
      return haystack === needle;
    case 'CONTAINS':
      return haystack.includes(needle);
    case 'IN':
      return needle
        .split(',')
        .map((s) => s.trim())
        .includes(haystack);
    case 'REGEX':
      try {
        // Limit regex length to guard against ReDoS
        if (clause.value.length > 150) return false;
        return new RegExp(clause.value, 'i').test(raw);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

export function evaluateRuleMatches(record: CategorisableRecord, rule: CategoryRuleRow): boolean {
  const { operator, clauses } = rule.conditions || { operator: 'AND', clauses: [] };
  if (!clauses || clauses.length === 0) return false;
  if (operator === 'OR') {
    return clauses.some((c) => evaluateClause(record, c));
  }
  return clauses.every((c) => evaluateClause(record, c));
}

export async function applyCategorisationBatch(
  tx: DbSession,
  records: CategorisableRecord[],
  activeRules: CategoryRuleRow[]
): Promise<void> {
  if (records.length === 0) return;

  for (const rec of records) {
    // 1. Hierarchical location grouping: State > District > City > Street
    const hierarchyParts: string[] = [];
    if (rec.state) hierarchyParts.push(rec.state);
    if (rec.district) hierarchyParts.push(rec.district);
    if (rec.city) hierarchyParts.push(rec.city);
    if (rec.street) hierarchyParts.push(rec.street);

    const tags: Array<{
      categoryType: string;
      categoryValue: string;
      hierarchyPath: string | null;
      ruleId: string | null;
      source: string;
    }> = [];

    if (rec.state) {
      tags.push({
        categoryType: 'LOCATION_STATE',
        categoryValue: rec.state,
        hierarchyPath: rec.state,
        ruleId: null,
        source: 'LOCATION_HIERARCHY',
      });
    }
    if (rec.district) {
      tags.push({
        categoryType: 'LOCATION_DISTRICT',
        categoryValue: rec.district,
        hierarchyPath: [rec.state, rec.district].filter(Boolean).join(' > '),
        ruleId: null,
        source: 'LOCATION_HIERARCHY',
      });
    }
    if (rec.city) {
      tags.push({
        categoryType: 'LOCATION_CITY',
        categoryValue: rec.city,
        hierarchyPath: [rec.state, rec.district, rec.city].filter(Boolean).join(' > '),
        ruleId: null,
        source: 'LOCATION_HIERARCHY',
      });
    }
    if (rec.area) {
      tags.push({
        categoryType: 'LOCATION_AREA',
        categoryValue: rec.area,
        hierarchyPath: [rec.city, rec.area].filter(Boolean).join(' > '),
        ruleId: null,
        source: 'LOCATION_HIERARCHY',
      });
    }
    const effectiveStreet =
      rec.street_group && rec.street_group !== 'UNIDENTIFIED' ? rec.street_group : rec.street;
    if (effectiveStreet) {
      tags.push({
        categoryType: 'LOCATION_STREET',
        categoryValue: effectiveStreet,
        hierarchyPath: [rec.area, rec.sub_area, effectiveStreet].filter(Boolean).join(' > ') || hierarchyParts.join(' > '),
        ruleId: null,
        source: 'LOCATION_HIERARCHY',
      });
    }

    // 2. Other-fields automatic business/customer category hints
    const extra = rec.other_fields || {};
    for (const [k, v] of Object.entries(extra)) {
      const val = String(v ?? '').trim();
      if (!val) continue;
      if (/business|segment|category|industry/i.test(k)) {
        tags.push({
          categoryType: 'BUSINESS_CATEGORY',
          categoryValue: val,
          hierarchyPath: val,
          ruleId: null,
          source: 'RULE',
        });
      } else if (/customer[_\s]?type|tier|group/i.test(k)) {
        tags.push({
          categoryType: 'CUSTOMER_TYPE',
          categoryValue: val,
          hierarchyPath: val,
          ruleId: null,
          source: 'RULE',
        });
      }
    }

    // 3. Priority-ordered user-configured rules
    for (const rule of activeRules) {
      if (evaluateRuleMatches(rec, rule)) {
        tags.push({
          categoryType: rule.category_type,
          categoryValue: rule.category_value,
          hierarchyPath: rule.category_value,
          ruleId: rule.id,
          source: 'RULE',
        });
      }
    }

    // Replace rule/location generated categories while keeping MANUAL ones
    await tx.query(
      `DELETE FROM record_categories WHERE clean_record_id = $1 AND source <> 'MANUAL'`,
      [rec.id]
    );

    for (const t of tags) {
      await tx.query(
        `INSERT INTO record_categories (clean_record_id, category_type, category_value, hierarchy_path, rule_id, source, confidence)
         VALUES ($1, $2, $3, $4, $5, $6, 1.000)
         ON CONFLICT (clean_record_id, category_type, category_value)
         DO UPDATE SET hierarchy_path = EXCLUDED.hierarchy_path, rule_id = EXCLUDED.rule_id`,
        [rec.id, t.categoryType, t.categoryValue, t.hierarchyPath, t.ruleId, t.source]
      );
    }
  }
}

export class CategorisationRepository {
  async listRules(activeOnly = false) {
    const db = getDb();
    const res = await db.query<CategoryRuleRow>(
      `SELECT * FROM category_rules ${activeOnly ? 'WHERE is_active = true' : ''} ORDER BY priority ASC, created_at ASC`
    );
    return res.rows;
  }

  async createRule(data: z.infer<typeof CategoryRuleSchema>, createdBy: string) {
    const db = getDb();
    const res = await db.query(
      `INSERT INTO category_rules (name, priority, category_type, category_value, parent_rule_id, conditions, is_active, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
       RETURNING *`,
      [
        data.name,
        data.priority,
        data.categoryType,
        data.categoryValue,
        data.parentRuleId || null,
        JSON.stringify(data.conditions),
        data.isActive,
        createdBy,
      ]
    );
    return res.rows[0];
  }

  async updateRule(id: string, patch: Partial<z.infer<typeof CategoryRuleSchema>>) {
    const db = getDb();
    const sets: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [id];

    if (patch.name !== undefined) {
      params.push(patch.name);
      sets.push(`name = $${params.length}`);
    }
    if (patch.priority !== undefined) {
      params.push(patch.priority);
      sets.push(`priority = $${params.length}`);
    }
    if (patch.categoryType !== undefined) {
      params.push(patch.categoryType);
      sets.push(`category_type = $${params.length}`);
    }
    if (patch.categoryValue !== undefined) {
      params.push(patch.categoryValue);
      sets.push(`category_value = $${params.length}`);
    }
    if (patch.conditions !== undefined) {
      params.push(JSON.stringify(patch.conditions));
      sets.push(`conditions = $${params.length}::jsonb`);
    }
    if (patch.isActive !== undefined) {
      params.push(patch.isActive);
      sets.push(`is_active = $${params.length}`);
    }

    const res = await db.query(`UPDATE category_rules SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
    return res.rows[0] || null;
  }

  async deleteRule(id: string) {
    const db = getDb();
    await db.query('DELETE FROM category_rules WHERE id = $1', [id]);
  }

  async getHierarchyAndGroups(uploadId?: string) {
    const db = getDb();
    const params: unknown[] = [];
    let uploadWhere = '';
    if (uploadId) {
      params.push(uploadId);
      uploadWhere = `AND cr.upload_id = $1`;
    }

    // Hierarchical Location summary (State > District > City)
    const locRes = await db.query<{
      state: string | null;
      district: string | null;
      city: string | null;
      count: string;
    }>(
      `SELECT COALESCE(cr.state, 'Unspecified State') AS state,
              COALESCE(cr.district, 'Unspecified District') AS district,
              COALESCE(cr.city, 'Unspecified City') AS city,
              COUNT(*)::text AS count
       FROM clean_records cr
       WHERE cr.deleted_at IS NULL AND cr.is_merged = false ${uploadWhere}
       GROUP BY 1, 2, 3
       ORDER BY COUNT(*) DESC, 1, 2, 3
       LIMIT 300`,
      params
    );

    // Category breakdown
    const catRes = await db.query<{
      category_type: string;
      category_value: string;
      count: string;
    }>(
      `SELECT rc.category_type, rc.category_value, COUNT(DISTINCT rc.clean_record_id)::text AS count
       FROM record_categories rc
       JOIN clean_records cr ON cr.id = rc.clean_record_id
       WHERE cr.deleted_at IS NULL AND cr.is_merged = false ${uploadWhere}
       GROUP BY rc.category_type, rc.category_value
       ORDER BY COUNT(DISTINCT rc.clean_record_id) DESC
       LIMIT 200`,
      params
    );

    return {
      locationTree: locRes.rows.map((r) => ({ ...r, count: Number(r.count) })),
      categories: catRes.rows.map((r) => ({ ...r, count: Number(r.count) })),
    };
  }

  async recalculateAll(uploadId?: string) {
    const db = getDb();
    const rules = await this.listRules(true);
    const params: unknown[] = [];
    let where = 'WHERE deleted_at IS NULL AND is_merged = false';
    if (uploadId) {
      params.push(uploadId);
      where += ` AND upload_id = $1`;
    }
    const recs = await db.query<CategorisableRecord>(
      `SELECT id, full_name, street, street_group, sub_area, area, city, district, state, pin_code, phone_e164, other_fields
       FROM clean_records ${where}`,
      params
    );
    await db.transaction(async (tx) => {
      await applyCategorisationBatch(tx, recs.rows, rules);
    });
    return { updatedRecords: recs.rows.length };
  }
}

export const categorisationRepo = new CategorisationRepository();

export function createCategorisationRouter() {
  const router = Router();
  router.use(requireAuth);

  router.get('/rules', requirePermission('view'), async (_req, res, next) => {
    try {
      const items = await categorisationRepo.listRules(false);
      res.json({ items });
    } catch (err) {
      next(err);
    }
  });

  router.post('/rules', requirePermission('process'), validateBody(CategoryRuleSchema), async (req: AuthenticatedRequest, res, next) => {
    try {
      const rule = await categorisationRepo.createRule(req.body, req.authUser!.id);
      await emitAuditLog({
        actorId: req.authUser!.id,
        actorRole: req.authUser!.role,
        action: 'CATEGORY_RULE_CREATE',
        resourceType: 'category_rule',
        resourceId: rule.id,
        req,
      });
      res.status(201).json({ rule });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/rules/:id', requirePermission('process'), validateUuidParams('id'), validateBody(CategoryRuleSchema.partial()), async (req: AuthenticatedRequest, res, next) => {
    try {
      const rule = await categorisationRepo.updateRule(String(req.params.id), req.body);
      if (!rule) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Rule not found.' } });
      }
      res.json({ rule });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/rules/:id', requirePermission('delete'), validateUuidParams('id'), async (req, res, next) => {
    try {
      await categorisationRepo.deleteRule(String(req.params.id));
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  router.post('/recalculate', requirePermission('process'), async (req: AuthenticatedRequest, res, next) => {
    try {
      const uploadId = typeof req.body?.uploadId === 'string' && req.body.uploadId ? req.body.uploadId : undefined;
      if (uploadId && !isValidUuid(uploadId)) {
        return res.status(400).json({ error: { code: 'INVALID_ID', message: 'Parameter "uploadId" must be a valid UUID.' } });
      }
      const result = await categorisationRepo.recalculateAll(uploadId);
      await emitAuditLog({
        actorId: req.authUser!.id,
        actorRole: req.authUser!.role,
        action: 'CATEGORIES_RECALCULATE',
        resourceType: 'upload',
        resourceId: uploadId || 'ALL',
        req,
        metadata: result,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get('/tree', requirePermission('view'), async (req, res, next) => {
    try {
      const uploadId = typeof req.query.uploadId === 'string' && req.query.uploadId ? req.query.uploadId : undefined;
      if (uploadId && !isValidUuid(uploadId)) {
        return res.status(400).json({ error: { code: 'INVALID_ID', message: 'Query parameter "uploadId" must be a valid UUID.' } });
      }
      const tree = await categorisationRepo.getHierarchyAndGroups(uploadId);
      res.json(tree);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
