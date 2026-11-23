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
import { normalizeForMatch } from '../processing/cleaning.engine.ts';

// Jaro-Winkler similarity (0..1)
export function jaroWinkler(s1Raw: string, s2Raw: string): number {
  const s1 = s1Raw.trim().toLowerCase();
  const s2 = s2Raw.trim().toLowerCase();
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;

  const len1 = s1.length;
  const len2 = s2.length;
  const matchWindow = Math.max(0, Math.floor(Math.max(len1, len2) / 2) - 1);
  const s1Matches = new Array(len1).fill(false);
  const s2Matches = new Array(len2).fill(false);

  let matches = 0;
  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, len2);
    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let t = 0;
  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) t++;
    k++;
  }

  const jaro = (matches / len1 + matches / len2 + (matches - t / 2) / matches) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, len1, len2); i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }
  return Number((jaro + prefix * 0.1 * (1 - jaro)).toFixed(4));
}

export function levenshteinSimilarity(aRaw: string, bRaw: string): number {
  const a = aRaw.trim().toLowerCase();
  const b = bRaw.trim().toLowerCase();
  if (!a || !b) return 0;
  if (a === b) return 1;
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return Number((1 - dp[m][n] / Math.max(m, n)).toFixed(4));
}

// Phonetic key tuned for both English & transliterated South Indian names while keeping Tamil intact
export function phoneticKey(name: string | null): string {
  if (!name) return '';
  const norm = (normalizeForMatch(name) || '').replace(/\s+/g, '');
  if (!norm) return '';
  if (/[^\u0000-\u007F]/.test(norm)) {
    return norm.slice(0, 6);
  }
  return norm
    .replace(/ph/g, 'f')
    .replace(/th/g, 't')
    .replace(/dh/g, 'd')
    .replace(/bh/g, 'b')
    .replace(/ck/g, 'k')
    .replace(/w/g, 'v')
    .replace(/([a-z])\1+/g, '$1')
    .replace(/[aeiou]/g, '')
    .slice(0, 8);
}

interface CandidateRow {
  id: string;
  upload_id: string;
  consumer_id: string | null;
  full_name: string | null;
  normalized_name: string | null;
  street: string | null;
  area: string | null;
  city: string | null;
  pin_code: string | null;
  phone_e164: string | null;
  row_fingerprint: string;
  status: string;
}

export async function detectDuplicatesForUpload(
  uploadId: string,
  options: { nameThreshold?: number; addressThreshold?: number; includeApprovedMaster?: boolean } = {}
): Promise<number> {
  const db = getDb();
  const nameThreshold = options.nameThreshold ?? 0.86;
  const addressThreshold = options.addressThreshold ?? 0.80;

  const uploadRes = await db.query<CandidateRow>(
    `SELECT cr.id, cr.upload_id, cr.consumer_id, cr.full_name, cr.normalized_name, cr.street, cr.area, cr.city, cr.pin_code, cr.phone_e164, rr.row_fingerprint, cr.status
     FROM clean_records cr
     JOIN raw_records rr ON rr.id = cr.raw_record_id
     WHERE cr.upload_id = $1 AND cr.deleted_at IS NULL AND cr.is_merged = false`,
    [uploadId]
  );

  let pool: CandidateRow[] = [...uploadRes.rows];
  if (options.includeApprovedMaster) {
    const masterRes = await db.query<CandidateRow>(
      `SELECT cr.id, cr.upload_id, cr.consumer_id, cr.full_name, cr.normalized_name, cr.street, cr.area, cr.city, cr.pin_code, cr.phone_e164, rr.row_fingerprint, cr.status
       FROM clean_records cr
       JOIN raw_records rr ON rr.id = cr.raw_record_id
       WHERE cr.upload_id <> $1 AND cr.status = 'APPROVED' AND cr.deleted_at IS NULL AND cr.is_merged = false
       LIMIT 25000`,
      [uploadId]
    );
    pool = pool.concat(masterRes.rows);
  }

  if (pool.length < 2) return 0;

  // Blocking buckets to eliminate O(n^2)
  const blocks = new Map<string, CandidateRow[]>();
  const addToBlock = (key: string, row: CandidateRow) => {
    const list = blocks.get(key) || [];
    list.push(row);
    blocks.set(key, list);
  };

  for (const row of pool) {
    if (row.row_fingerprint) addToBlock(`FP:${row.row_fingerprint}`, row);
    if (row.consumer_id && row.consumer_id.trim()) {
      addToBlock(`CID:${row.consumer_id.trim().toLowerCase()}`, row);
    }
    if (row.phone_e164) addToBlock(`PH:${row.phone_e164}`, row);
    const nameKey = phoneticKey(row.full_name);
    if (row.pin_code && nameKey) addToBlock(`PN:${row.pin_code}:${nameKey.slice(0, 3)}`, row);
    if (row.city && nameKey) addToBlock(`CT:${row.city.toLowerCase()}:${nameKey.slice(0, 4)}`, row);
    if (nameKey && nameKey.length >= 4) addToBlock(`NM:${nameKey}`, row);
  }

  // Union-Find over edges found inside small blocks
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let cur = x;
    while (parent.get(cur) && parent.get(cur) !== cur) cur = parent.get(cur)!;
    let p = x;
    while (p !== cur) {
      const nxt = parent.get(p) || cur;
      parent.set(p, cur);
      p = nxt;
    }
    return cur;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };

  interface EdgeInfo {
    score: number;
    matchType: string;
    reasons: Set<string>;
  }
  const pairMeta = new Map<string, EdgeInfo>();
  const seenPairs = new Set<string>();

  for (const bucket of blocks.values()) {
    if (bucket.length < 2 || bucket.length > 100) continue; // cap oversized noisy blocks
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i];
        const b = bucket[j];
        if (a.upload_id !== uploadId && b.upload_id !== uploadId) continue;
        const pairKey = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);

        const reasons = new Set<string>();
        let score = 0;
        let matchType = '';

        if (a.row_fingerprint === b.row_fingerprint) {
          score = 1.0;
          matchType = 'EXACT_FINGERPRINT';
          reasons.add('EXACT_ROW_FINGERPRINT');
        } else if (a.consumer_id && b.consumer_id && a.consumer_id.trim().toLowerCase() === b.consumer_id.trim().toLowerCase()) {
          score = 0.99;
          matchType =
            a.area && b.area && a.area.toLowerCase() !== b.area.toLowerCase()
              ? 'CROSS_AREA_DUPLICATE_CONSUMER_ID'
              : 'DUPLICATE_CONSUMER_ID';
          reasons.add('CONSUMER_ID_EXACT_MATCH');
          if (a.area && b.area && a.area.toLowerCase() !== b.area.toLowerCase()) {
            reasons.add('CROSS_AREA_DUPLICATE');
          }
        } else if (a.phone_e164 && b.phone_e164 && a.phone_e164 === b.phone_e164) {
          const nameSim = a.normalized_name && b.normalized_name ? jaroWinkler(a.normalized_name, b.normalized_name) : 0;
          if (nameSim >= nameThreshold) {
            score = Number((0.92 + 0.08 * nameSim).toFixed(3));
            matchType = a.upload_id !== b.upload_id
              ? 'CROSS_UPLOAD_MASTER'
              : a.area && b.area && a.area.toLowerCase() !== b.area.toLowerCase()
                ? 'CROSS_AREA_DUPLICATE'
                : 'FUZZY_NAME_ADDRESS';
            reasons.add('PHONE_EXACT_MATCH');
            reasons.add(`NAME_SIMILARITY_${nameSim.toFixed(2)}`);
          } else {
            score = 0.88;
            matchType = 'SAME_PHONE_DIFF_NAME';
            reasons.add('SAME_PHONE_DIFFERENT_NAME');
          }
        } else {
          const nameSim = a.normalized_name && b.normalized_name ? jaroWinkler(a.normalized_name, b.normalized_name) : 0;
          const addrA = [a.street, a.area, a.city].filter(Boolean).join(' ');
          const addrB = [b.street, b.area, b.city].filter(Boolean).join(' ');
          const addrSim = addrA && addrB ? levenshteinSimilarity(addrA, addrB) : 0;

          if (nameSim >= nameThreshold && (addrSim >= addressThreshold || (a.pin_code && a.pin_code === b.pin_code))) {
            score = Number((0.55 * nameSim + 0.45 * Math.max(addrSim, a.pin_code === b.pin_code ? 0.85 : 0)).toFixed(3));
            matchType = a.upload_id !== b.upload_id
              ? 'CROSS_UPLOAD_MASTER'
              : a.area && b.area && a.area.toLowerCase() !== b.area.toLowerCase()
                ? 'CROSS_AREA_DUPLICATE'
                : 'FUZZY_NAME_ADDRESS';
            reasons.add(`NAME_JARO_WINKLER_${nameSim.toFixed(2)}`);
            if (addrSim >= addressThreshold) reasons.add(`ADDRESS_SIMILARITY_${addrSim.toFixed(2)}`);
            if (a.pin_code && a.pin_code === b.pin_code) reasons.add('PIN_EXACT_MATCH');
          }
        }

        if (score > 0) {
          parent.set(a.id, parent.get(a.id) || a.id);
          parent.set(b.id, parent.get(b.id) || b.id);
          union(a.id, b.id);
          pairMeta.set(pairKey, { score, matchType, reasons });
        }
      }
    }
  }

  // Collect connected components
  const groups = new Map<string, CandidateRow[]>();
  const rowById = new Map(pool.map((r) => [r.id, r]));
  for (const id of parent.keys()) {
    const root = find(id);
    const list = groups.get(root) || [];
    const r = rowById.get(id);
    if (r) list.push(r);
    groups.set(root, list);
  }

  let createdCount = 0;
  await db.transaction(async (tx) => {
    // Clear previous pending groups for this upload before recreating
    await tx.query(
      `DELETE FROM duplicate_groups WHERE upload_id = $1 AND status = 'PENDING'`,
      [uploadId]
    );

    for (const members of groups.values()) {
      if (members.length < 2) continue;
      let maxScore = 0;
      let primaryType = 'FUZZY_NAME_ADDRESS';
      const allReasons = new Set<string>();

      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          const pk = members[i].id < members[j].id ? `${members[i].id}|${members[j].id}` : `${members[j].id}|${members[i].id}`;
          const info = pairMeta.get(pk);
          if (info) {
            if (info.score > maxScore) {
              maxScore = info.score;
              primaryType = info.matchType;
            }
            info.reasons.forEach((r) => allReasons.add(r));
          }
        }
      }

      const grpRes = await tx.query<{ id: string }>(
        `INSERT INTO duplicate_groups (upload_id, match_type, confidence, status)
         VALUES ($1, $2, $3, 'PENDING') RETURNING id`,
        [uploadId, primaryType, maxScore || 0.85]
      );
      const groupId = grpRes.rows[0].id;

      // Suggest primary: prefer APPROVED master, else most complete fields
      const sorted = [...members].sort((a, b) => {
        if (a.status === 'APPROVED' && b.status !== 'APPROVED') return -1;
        if (b.status === 'APPROVED' && a.status !== 'APPROVED') return 1;
        const scoreA = [a.full_name, a.street, a.city, a.pin_code, a.phone_e164].filter(Boolean).length;
        const scoreB = [b.full_name, b.street, b.city, b.pin_code, b.phone_e164].filter(Boolean).length;
        return scoreB - scoreA;
      });

      for (let idx = 0; idx < sorted.length; idx++) {
        const m = sorted[idx];
        await tx.query(
          `INSERT INTO duplicate_members (group_id, clean_record_id, match_score, match_reasons, is_suggested_primary)
           VALUES ($1, $2, $3, $4::jsonb, $5)
           ON CONFLICT DO NOTHING`,
          [groupId, m.id, maxScore || 0.85, JSON.stringify(Array.from(allReasons)), idx === 0]
        );
        if (m.upload_id === uploadId && m.status !== 'APPROVED') {
          await tx.query(
            `UPDATE clean_records SET status = 'POTENTIAL_DUPLICATE', updated_at = NOW() WHERE id = $1`,
            [m.id]
          );
        }
      }
      createdCount++;
    }
  });

  return createdCount;
}

const MergeSchema = z.object({
  survivingRecordId: z.string().uuid(),
  fieldSelections: z.record(z.string(), z.string().uuid()).default({}),
});

export function createDuplicatesRouter() {
  const router = Router();
  router.use(requireAuth);

  router.post('/scan', requirePermission('process'), async (req: AuthenticatedRequest, res, next) => {
    try {
      const db = getDb();
      const uploadId = typeof req.body?.uploadId === 'string' && req.body.uploadId ? req.body.uploadId : null;
      if (uploadId && !isValidUuid(uploadId)) {
        return res.status(400).json({ error: { code: 'INVALID_ID', message: 'Parameter "uploadId" must be a valid UUID.' } });
      }
      const { settingsService } = await import('../settings/settings.module.ts');
      const nameThreshold = Number(await settingsService.getSetting('dedupe.name_similarity_threshold', 0.86));
      const addressThreshold = Number(await settingsService.getSetting('dedupe.address_similarity_threshold', 0.80));

      let uploadIds: string[] = [];
      if (uploadId) {
        uploadIds = [uploadId];
      } else {
        const upRes = await db.query<{ id: string }>(
          `SELECT id FROM uploads WHERE deleted_at IS NULL AND status = 'PROCESSED' ORDER BY created_at DESC LIMIT 50`
        );
        uploadIds = upRes.rows.map((r) => r.id);
      }

      let groupsCreated = 0;
      for (const id of uploadIds) {
        groupsCreated += await detectDuplicatesForUpload(id, {
          nameThreshold,
          addressThreshold,
          includeApprovedMaster: true,
        });
      }

      await emitAuditLog({
        actorId: req.authUser!.id,
        actorRole: req.authUser!.role,
        action: 'DUPLICATE_SCAN',
        resourceType: 'duplicate_group',
        resourceId: uploadId || 'ALL',
        req,
        metadata: { scannedUploads: uploadIds.length, groupsCreated },
      });

      res.json({ scannedUploads: uploadIds.length, groupsCreated });
    } catch (err) {
      next(err);
    }
  });

  router.get('/', requirePermission('view'), async (req, res, next) => {
    try {
      const db = getDb();
      const uploadId = typeof req.query.uploadId === 'string' && req.query.uploadId ? req.query.uploadId : undefined;
      if (uploadId && !isValidUuid(uploadId)) {
        return res.status(400).json({ error: { code: 'INVALID_ID', message: 'Query parameter "uploadId" must be a valid UUID.' } });
      }
      const status = typeof req.query.status === 'string' ? req.query.status : 'PENDING';
      const page = Math.max(1, Number(req.query.page || 1));
      const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize || 25)));

      const conds: string[] = [];
      const params: unknown[] = [];
      if (uploadId) {
        params.push(uploadId);
        conds.push(`dg.upload_id = $${params.length}`);
      }
      if (status && status !== 'ALL') {
        params.push(status);
        conds.push(`dg.status = $${params.length}`);
      }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const countRes = await db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM duplicate_groups dg ${where}`,
        params
      );
      const total = Number(countRes.rows[0]?.count || 0);
      const offset = (page - 1) * pageSize;
      params.push(pageSize, offset);

      const groupsRes = await db.query(
        `SELECT dg.*,
                (SELECT COUNT(*)::int FROM duplicate_members dm WHERE dm.group_id = dg.id) AS member_count,
                (SELECT json_agg(json_build_object(
                   'id', cr.id,
                   'fullName', cr.full_name,
                   'phoneDisplay', cr.phone_display,
                   'city', cr.city,
                   'street', cr.street,
                   'pinCode', cr.pin_code,
                   'status', cr.status,
                   'matchScore', dm.match_score,
                   'matchReasons', dm.match_reasons,
                   'isSuggestedPrimary', dm.is_suggested_primary
                 ))
                 FROM duplicate_members dm
                 JOIN clean_records cr ON cr.id = dm.clean_record_id
                 WHERE dm.group_id = dg.id) AS members_preview
         FROM duplicate_groups dg
         ${where}
         ORDER BY dg.confidence DESC, dg.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );

      res.json({ items: groupsRes.rows, total });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:groupId', requirePermission('view'), validateUuidParams('groupId'), async (req, res, next) => {
    try {
      const db = getDb();
      const groupId = String(req.params.groupId);
      const grpRes = await db.query('SELECT * FROM duplicate_groups WHERE id = $1', [groupId]);
      if (!grpRes.rows[0]) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Duplicate group not found.' } });
      }
      const membersRes = await db.query(
        `SELECT dm.match_score, dm.match_reasons, dm.is_suggested_primary,
                cr.*, rr.raw_data, rr.row_number
         FROM duplicate_members dm
         JOIN clean_records cr ON cr.id = dm.clean_record_id
         JOIN raw_records rr ON rr.id = cr.raw_record_id
         WHERE dm.group_id = $1
         ORDER BY dm.is_suggested_primary DESC, cr.created_at ASC`,
        [groupId]
      );
      res.json({ group: grpRes.rows[0], members: membersRes.rows });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:groupId/merge', requirePermission('approve'), validateUuidParams('groupId'), validateBody(MergeSchema), async (req: AuthenticatedRequest, res, next) => {
    try {
      const db = getDb();
      const groupId = String(req.params.groupId);
      const { survivingRecordId, fieldSelections } = req.body as z.infer<typeof MergeSchema>;

      const out = await db.transaction(async (tx: DbSession) => {
        const grpRes = await tx.query<{ id: string; status: string }>('SELECT id, status FROM duplicate_groups WHERE id = $1', [groupId]);
        if (!grpRes.rows[0]) return { error: 404 as const, message: 'Duplicate group not found.' };
        if (grpRes.rows[0].status === 'MERGED') return { error: 400 as const, message: 'Group is already merged.' };

        const membersRes = await tx.query<Record<string, any>>(
          `SELECT cr.* FROM duplicate_members dm JOIN clean_records cr ON cr.id = dm.clean_record_id WHERE dm.group_id = $1`,
          [groupId]
        );
        const byId = new Map(membersRes.rows.map((r) => [r.id as string, r]));
        const survivor = byId.get(survivingRecordId);
        if (!survivor) return { error: 400 as const, message: 'Surviving record is not part of this duplicate group.' };

        const mergeFields = ['full_name', 'street', 'area', 'city', 'district', 'state', 'pin_code', 'phone_e164', 'phone_display'];
        const updatedFields: Record<string, unknown> = {};
        const changedFields: string[] = [];

        for (const field of mergeFields) {
          const chosenId = fieldSelections[field];
          if (chosenId && byId.has(chosenId)) {
            const val = byId.get(chosenId)![field];
            if (val !== survivor[field]) {
              updatedFields[field] = val;
              changedFields.push(field);
            }
          }
        }

        const beforeSurvivor = { ...survivor };
        const nextSurvivorRes = await tx.query(
          `UPDATE clean_records
           SET full_name = COALESCE($2, full_name),
               street = COALESCE($3, street),
               area = COALESCE($4, area),
               city = COALESCE($5, city),
               district = COALESCE($6, district),
               state = COALESCE($7, state),
               pin_code = COALESCE($8, pin_code),
               phone_e164 = COALESCE($9, phone_e164),
               phone_display = COALESCE($10, phone_display),
               status = CASE WHEN status = 'POTENTIAL_DUPLICATE' THEN 'VERIFIED'::record_status ELSE status END,
               updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [
            survivingRecordId,
            updatedFields.full_name ?? survivor.full_name,
            updatedFields.street ?? survivor.street,
            updatedFields.area ?? survivor.area,
            updatedFields.city ?? survivor.city,
            updatedFields.district ?? survivor.district,
            updatedFields.state ?? survivor.state,
            updatedFields.pin_code ?? survivor.pin_code,
            updatedFields.phone_e164 ?? survivor.phone_e164,
            updatedFields.phone_display ?? survivor.phone_display,
          ]
        );

        await tx.query(
          `INSERT INTO record_history (clean_record_id, action, before_state, after_state, changed_fields, duplicate_group_id, actor_id)
           VALUES ($1, 'MERGED', $2::jsonb, $3::jsonb, $4, $5, $6)`,
          [
            survivingRecordId,
            JSON.stringify(beforeSurvivor),
            JSON.stringify(nextSurvivorRes.rows[0]),
            changedFields,
            groupId,
            req.authUser!.id,
          ]
        );

        // Soft-mark non-surviving duplicates as merged (never deleted!)
        for (const member of membersRes.rows) {
          if (member.id === survivingRecordId) continue;
          const afterMemberRes = await tx.query(
            `UPDATE clean_records SET is_merged = true, merged_into_id = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
            [member.id, survivingRecordId]
          );
          await tx.query(
            `INSERT INTO record_history (clean_record_id, action, before_state, after_state, changed_fields, duplicate_group_id, actor_id)
             VALUES ($1, 'MERGED', $2::jsonb, $3::jsonb, $4, $5, $6)`,
            [
              member.id,
              JSON.stringify(member),
              JSON.stringify(afterMemberRes.rows[0]),
              ['is_merged', 'merged_into_id'],
              groupId,
              req.authUser!.id,
            ]
          );
        }

        const updatedGrp = await tx.query(
          `UPDATE duplicate_groups SET status = 'MERGED', surviving_record_id = $2, resolved_by = $3, resolved_at = NOW()
           WHERE id = $1 RETURNING *`,
          [groupId, survivingRecordId, req.authUser!.id]
        );

        return { survivingRecord: nextSurvivorRes.rows[0], group: updatedGrp.rows[0] };
      });

      if ('error' in out && typeof out.error === 'number') {
        return res.status(out.error).json({ error: { code: 'MERGE_ERROR', message: out.message } });
      }

      await emitAuditLog({
        actorId: req.authUser!.id,
        actorRole: req.authUser!.role,
        action: 'DUPLICATE_MERGE',
        resourceType: 'duplicate_group',
        resourceId: groupId,
        req,
        metadata: { survivingRecordId },
      });

      res.json(out);
    } catch (err) {
      next(err);
    }
  });

  router.post('/:groupId/dismiss', requirePermission('approve'), validateUuidParams('groupId'), async (req: AuthenticatedRequest, res, next) => {
    try {
      const db = getDb();
      const groupId = String(req.params.groupId);
      const updated = await db.transaction(async (tx) => {
        const grp = await tx.query(
          `UPDATE duplicate_groups SET status = 'DISMISSED', resolved_by = $2, resolved_at = NOW()
           WHERE id = $1 RETURNING *`,
          [groupId, req.authUser!.id]
        );
        if (!grp.rows[0]) return null;
        await tx.query(
          `UPDATE clean_records cr
           SET status = 'NEEDS_REVIEW', updated_at = NOW()
           FROM duplicate_members dm
           WHERE dm.group_id = $1 AND dm.clean_record_id = cr.id AND cr.status = 'POTENTIAL_DUPLICATE'`,
          [groupId]
        );
        return grp.rows[0];
      });
      if (!updated) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Duplicate group not found.' } });
      }
      res.json({ group: updated });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:groupId/revert', requirePermission('approve'), validateUuidParams('groupId'), async (req: AuthenticatedRequest, res, next) => {
    try {
      const db = getDb();
      const groupId = String(req.params.groupId);
      const result = await db.transaction(async (tx) => {
        const grpRes = await tx.query<{ id: string; status: string }>(
          'SELECT id, status FROM duplicate_groups WHERE id = $1',
          [groupId]
        );
        if (!grpRes.rows[0]) return { error: 404 as const, message: 'Duplicate group not found.' };
        if (grpRes.rows[0].status !== 'MERGED') {
          return { error: 400 as const, message: 'Only merged duplicate groups can be reverted.' };
        }

        const histRes = await tx.query<{
          id: string;
          clean_record_id: string;
          before_state: Record<string, any>;
        }>(
          `SELECT id, clean_record_id, before_state
           FROM record_history
           WHERE duplicate_group_id = $1 AND action = 'MERGED'
           ORDER BY created_at DESC`,
          [groupId]
        );

        const restored: unknown[] = [];
        for (const h of histRes.rows) {
          const b = h.before_state;
          const upRes = await tx.query(
            `UPDATE clean_records
             SET full_name = $2, street = $3, area = $4, city = $5, district = $6, state = $7,
                 pin_code = $8, phone_e164 = $9, phone_display = $10, status = $11::record_status,
                 is_merged = false, merged_into_id = NULL, updated_at = NOW()
             WHERE id = $1 RETURNING *`,
            [
              h.clean_record_id,
              b.full_name ?? null,
              b.street ?? null,
              b.area ?? null,
              b.city ?? null,
              b.district ?? null,
              b.state ?? null,
              b.pin_code ?? null,
              b.phone_e164 ?? null,
              b.phone_display ?? null,
              b.status || 'POTENTIAL_DUPLICATE',
            ]
          );
          if (upRes.rows[0]) {
            restored.push(upRes.rows[0]);
            await tx.query(
              `INSERT INTO record_history (clean_record_id, action, before_state, after_state, changed_fields, duplicate_group_id, revert_of_history_id, actor_id)
               VALUES ($1, 'MERGE_REVERTED', $2::jsonb, $3::jsonb, $4, $5, $6, $7)`,
              [
                h.clean_record_id,
                JSON.stringify({ is_merged: true }),
                JSON.stringify(upRes.rows[0]),
                ['is_merged', 'merged_into_id', 'status'],
                groupId,
                h.id,
                req.authUser!.id,
              ]
            );
          }
        }

        const grpUp = await tx.query(
          `UPDATE duplicate_groups SET status = 'REVERTED', surviving_record_id = NULL, resolved_by = $2, resolved_at = NOW()
           WHERE id = $1 RETURNING *`,
          [groupId, req.authUser!.id]
        );
        return { restoredRecords: restored, group: grpUp.rows[0] };
      });

      if ('error' in result && typeof result.error === 'number') {
        return res.status(result.error).json({ error: { code: 'REVERT_ERROR', message: result.message } });
      }

      await emitAuditLog({
        actorId: req.authUser!.id,
        actorRole: req.authUser!.role,
        action: 'DUPLICATE_REVERT',
        resourceType: 'duplicate_group',
        resourceId: groupId,
        req,
      });

      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
