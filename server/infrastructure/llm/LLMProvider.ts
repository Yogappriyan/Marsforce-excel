import crypto from 'node:crypto';
import { GoogleGenAI, Type } from '@google/genai';
import { z } from 'zod';
import { env } from '../../config/env.ts';
import { getDb } from '../db/index.ts';

export const TargetFieldEnum = z.enum([
  'consumer_id',
  'distributor_id',
  'full_name',
  'address_combined',
  'street',
  'sub_area',
  'area',
  'city',
  'district',
  'state',
  'pin_code',
  'phone_raw',
  'phone_multi',
  'name_and_phone',
  'custom',
  'ignore',
]);

export type TargetField = z.infer<typeof TargetFieldEnum>;

export const ColumnDetectionResultSchema = z.object({
  mappings: z.array(
    z.object({
      sourceIndex: z.number().int().min(0),
      sourceColumn: z.string(),
      targetField: TargetFieldEnum,
      confidence: z.number().min(0).max(1),
      reason: z.string().optional(),
    })
  ),
});

export const AddressSplitItemSchema = z.object({
  input: z.string(),
  street: z.string().nullable().optional(),
  area: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  district: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  pinCode: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1),
});

export const AddressBatchSchema = z.object({
  items: z.array(AddressSplitItemSchema),
});

export const CategoryBatchItemSchema = z.object({
  input: z.string(),
  customerType: z.string().nullable().optional(),
  businessCategory: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1),
});

export const CategoryBatchSchema = z.object({
  items: z.array(CategoryBatchItemSchema),
});

export const GeoClassifyItemSchema = z.object({
  input: z.string(),
  suggestedArea: z.string().nullable().optional(),
  suggestedSubArea: z.string().nullable().optional(),
  suggestedStreet: z.string().nullable().optional(),
  groupType: z
    .enum([
      'STREET',
      'ROAD',
      'CROSS_STREET',
      'LANE',
      'COLONY',
      'NAGAR_LOCALITY',
      'LAYOUT',
      'SUB_AREA',
      'UNIDENTIFIED',
    ])
    .default('UNIDENTIFIED'),
  evidence: z.string().default(''),
  confidence: z.number().min(0).max(1),
  needsReview: z.boolean().default(true),
  explanation: z.string().default(''),
});

export const GeoClassifyBatchSchema = z.object({
  items: z.array(GeoClassifyItemSchema),
});

export const GeoRouteOrderSchema = z.object({
  orderedKeys: z.array(z.string()),
});

export interface GeoRoutePlaceInput {
  key: string;
  label: string;
  pins: string[];
  zones: string[];
  contextHints: string[];
}

export interface GeoRouteAreaInput {
  key: string;
  label: string;
  pins: string[];
  zones: string[];
  sampleLocalities: string[];
}

export type ColumnDetectionResult = z.infer<typeof ColumnDetectionResultSchema>;
export type AddressSplitItem = z.infer<typeof AddressSplitItemSchema>;
export type CategoryBatchItem = z.infer<typeof CategoryBatchItemSchema>;
export type GeoClassifyItem = z.infer<typeof GeoClassifyItemSchema>;

export interface LLMProvider {
  readonly providerName: 'gemini' | 'claude' | 'disabled';
  isConfigured(): boolean;
  getLastError(): string | null;
  detectColumnMappings(
    headers: string[],
    sampleRows: Record<string, string>[]
  ): Promise<ColumnDetectionResult | null>;
  extractAddressesBatch(uniqueAddresses: string[]): Promise<Map<string, AddressSplitItem>>;
  classifyAmbiguousAddressesBatch(uniquePayloads: string[]): Promise<Map<string, GeoClassifyItem>>;
  classifyCategoriesBatch(uniqueDescriptions: string[]): Promise<Map<string, CategoryBatchItem>>;
  orderLocalitiesByProximityBatch(
    areaName: string,
    places: GeoRoutePlaceInput[]
  ): Promise<string[] | null>;
  orderAreasByRouteProximity(
    regionHint: string,
    areas: GeoRouteAreaInput[]
  ): Promise<string[] | null>;
  testConnection(): Promise<{ ok: boolean; provider: string; model: string; message: string }>;
}

let geminiBlockedUntil = 0;
let geminiBlockedReason: string | null = null;
let geminiBlockedLogged = false;

export function resetGeminiCircuitBreaker(): void {
  geminiBlockedUntil = 0;
  geminiBlockedReason = null;
  geminiBlockedLogged = false;
}

export function getGeminiHealthWarning(): string | null {
  if (Date.now() < geminiBlockedUntil && geminiBlockedReason) {
    return geminiBlockedReason;
  }
  return null;
}

function classifyGeminiError(err: unknown): {
  userMessage: string;
  isPermanentAuthOrBilling: boolean;
  isTransient: boolean;
} {
  const raw = err instanceof Error ? err.message : String(err || '');
  const lower = raw.toLowerCase();

  if (
    lower.includes('permission_denied') ||
    lower.includes('"code":403') ||
    lower.includes('free tier is not available') ||
    lower.includes('billing')
  ) {
    return {
      userMessage:
        'Gemini API returned PERMISSION_DENIED (free tier unavailable or billing required for this project). Deterministic rules are handling processing; check GEMINI_API_KEY or billing in Settings > Secrets, or switch AI provider in Admin & Audit.',
      isPermanentAuthOrBilling: true,
      isTransient: false,
    };
  }

  if (lower.includes('api_key_invalid') || lower.includes('api key not valid') || lower.includes('"code":400')) {
    return {
      userMessage:
        'Gemini API key appears invalid (400). Verify GEMINI_API_KEY in Settings > Secrets; deterministic rules are handling processing.',
      isPermanentAuthOrBilling: true,
      isTransient: false,
    };
  }

  if (
    lower.includes('resource_exhausted') ||
    lower.includes('"code":429') ||
    lower.includes('429') ||
    lower.includes('"code":500') ||
    lower.includes('"code":502') ||
    lower.includes('"code":503') ||
    lower.includes('"code":504') ||
    lower.includes('timeout') ||
    lower.includes('econnreset') ||
    lower.includes('fetch failed')
  ) {
    return {
      userMessage:
        'Gemini API quota or temporary service limit reached. Deterministic rules handled fallback; verify quota/billing in Settings > Secrets if persistent.',
      isPermanentAuthOrBilling: false,
      isTransient: true,
    };
  }

  return {
    userMessage: `Gemini AI request fell back to deterministic rules (${raw.slice(0, 180)}).`,
    isPermanentAuthOrBilling: false,
    isTransient: false,
  };
}

function hashCacheKey(taskType: string, provider: string, input: string): string {
  return crypto
    .createHash('sha256')
    .update(`${taskType}|${provider}|${input.trim().toLowerCase()}`)
    .digest('hex');
}

async function readCacheBatch<T>(
  taskType: string,
  provider: string,
  inputs: string[],
  schema: z.ZodType<T>
): Promise<{ hits: Map<string, T>; misses: string[] }> {
  const hits = new Map<string, T>();
  if (inputs.length === 0) return { hits, misses: [] };

  const db = getDb();
  const keyToInput = new Map<string, string>();
  const keys: string[] = [];

  for (const input of inputs) {
    const key = hashCacheKey(taskType, provider, input);
    if (!keyToInput.has(key)) {
      keyToInput.set(key, input);
      keys.push(key);
    }
  }

  try {
    const res = await db.query<{ cache_key: string; response_json: unknown }>(
      `SELECT cache_key, response_json FROM llm_value_cache WHERE cache_key = ANY($1::text[])`,
      [keys]
    );
    const hitKeys = new Set<string>();
    for (const row of res.rows) {
      const parsed = schema.safeParse(row.response_json);
      const original = keyToInput.get(row.cache_key);
      if (parsed.success && original !== undefined) {
        hits.set(original, parsed.data);
        hitKeys.add(row.cache_key);
      }
    }
    if (hitKeys.size > 0) {
      await db.query(
        `UPDATE llm_value_cache SET hit_count = hit_count + 1, last_hit_at = NOW() WHERE cache_key = ANY($1::text[])`,
        [Array.from(hitKeys)]
      );
    }
  } catch {
    // Cache read error should never block processing
  }

  const misses = inputs.filter((inp) => !hits.has(inp));
  return { hits, misses };
}

async function writeCacheBatch(
  taskType: string,
  provider: string,
  entries: Array<{ input: string; value: unknown }>
): Promise<void> {
  if (entries.length === 0) return;
  const db = getDb();
  for (const entry of entries) {
    const key = hashCacheKey(taskType, provider, entry.input);
    try {
      await db.query(
        `INSERT INTO llm_value_cache (cache_key, task_type, provider, response_json)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (cache_key) DO UPDATE SET hit_count = llm_value_cache.hit_count + 1, last_hit_at = NOW()`,
        [key, taskType, provider, JSON.stringify(entry.value)]
      );
    } catch {
      // Ignore cache write contention
    }
  }
}

class GeminiLLMProvider implements LLMProvider {
  public readonly providerName = 'gemini' as const;
  private model: string;
  private lastError: string | null = getGeminiHealthWarning();

  constructor(model = 'gemini-4-hydrogen') {
    this.model = model;
  }

  isConfigured(): boolean {
    return Boolean(env.geminiApiKey);
  }

  getLastError(): string | null {
    return this.lastError || getGeminiHealthWarning();
  }

  private getClient(): GoogleGenAI {
    return new GoogleGenAI({
      apiKey: env.geminiApiKey,
      httpOptions: {
        headers: { 'User-Agent': 'aistudio-build' },
      },
    });
  }

  private async runWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    const blocked = getGeminiHealthWarning();
    if (blocked) {
      this.lastError = blocked;
      throw new Error(blocked);
    }

    const delays = [500, 1500];
    let lastErr: unknown;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        const res = await fn();
        this.lastError = null;
        return res;
      } catch (err) {
        lastErr = err;
        const info = classifyGeminiError(err);
        if (info.isPermanentAuthOrBilling) {
          geminiBlockedUntil = Date.now() + 5 * 60 * 1000;
          geminiBlockedReason = info.userMessage;
          this.lastError = info.userMessage;
          if (!geminiBlockedLogged) {
            geminiBlockedLogged = true;
            console.info('[LLM Gemini] AI enrichment paused (billing/API key check needed); using deterministic rules.');
          }
          throw err;
        }
        if (info.isTransient && attempt < delays.length) {
          await new Promise((r) => setTimeout(r, delays[attempt]));
          continue;
        }
        this.lastError = info.userMessage;
        throw err;
      }
    }
    throw lastErr;
  }

  async detectColumnMappings(
    headers: string[],
    sampleRows: Record<string, string>[]
  ): Promise<ColumnDetectionResult | null> {
    if (!this.isConfigured() || getGeminiHealthWarning()) return null;
    try {
      const ai = this.getClient();
      const sampled = sampleRows.slice(0, 30);
      const response = await this.runWithRetry(() =>
        ai.models.generateContent({
          model: this.model,
          contents: JSON.stringify({
            instruction:
              'Map each source column header to one MARSFORCE target field based on the header and up to 30 sampled rows. Allowed targetField values: consumer_id, distributor_id, full_name, address_combined, street, sub_area, area, city, district, state, pin_code, phone_raw, phone_multi, name_and_phone, custom, ignore.',
            headers: headers.map((h, i) => ({ sourceIndex: i, sourceColumn: h })),
            sampleRows: sampled,
          }),
          config: {
            systemInstruction:
              'You are a strict schema profiling engine. Never invent fields. Return valid JSON matching the schema.',
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                mappings: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      sourceIndex: { type: Type.INTEGER },
                      sourceColumn: { type: Type.STRING },
                      targetField: { type: Type.STRING },
                      confidence: { type: Type.NUMBER },
                      reason: { type: Type.STRING },
                    },
                  },
                },
              },
            },
          },
        })
      );

      const parsed = JSON.parse((response.text ?? '{}').trim());
      const validated = ColumnDetectionResultSchema.safeParse(parsed);
      return validated.success ? validated.data : null;
    } catch {
      return null;
    }
  }

  async extractAddressesBatch(uniqueAddresses: string[]): Promise<Map<string, AddressSplitItem>> {
    const result = new Map<string, AddressSplitItem>();
    if (!this.isConfigured() || uniqueAddresses.length === 0) return result;

    const { hits, misses } = await readCacheBatch(
      'ADDRESS_SPLIT',
      this.providerName,
      uniqueAddresses,
      AddressSplitItemSchema
    );
    for (const [k, v] of hits.entries()) result.set(k, v);
    if (misses.length === 0 || getGeminiHealthWarning()) return result;

    const batchSize = 30;
    const ai = this.getClient();

    for (let i = 0; i < misses.length; i += batchSize) {
      if (getGeminiHealthWarning()) break;
      const batch = misses.slice(i, i + batchSize);
      try {
        const response = await this.runWithRetry(() =>
          ai.models.generateContent({
            model: this.model,
            contents: JSON.stringify({
              instruction:
                'Parse each raw address string into street, area, city, district, state, pinCode (6 digits if present). NEVER invent missing components; return null for unknown fields. Preserve Tamil/Indic script faithfully.',
              addresses: batch,
            }),
            config: {
              systemInstruction:
                'You extract address parts strictly from the given string without inventing missing facts.',
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  items: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        input: { type: Type.STRING },
                        street: { type: Type.STRING },
                        area: { type: Type.STRING },
                        city: { type: Type.STRING },
                        district: { type: Type.STRING },
                        state: { type: Type.STRING },
                        pinCode: { type: Type.STRING },
                        confidence: { type: Type.NUMBER },
                      },
                    },
                  },
                },
              },
            },
          })
        );

        const parsed = JSON.parse((response.text ?? '{}').trim());
        const validated = AddressBatchSchema.safeParse(parsed);
        if (validated.success) {
          const toCache: Array<{ input: string; value: unknown }> = [];
          for (const item of validated.data.items) {
            result.set(item.input, item);
            toCache.push({ input: item.input, value: item });
          }
          await writeCacheBatch('ADDRESS_SPLIT', this.providerName, toCache);
        }
      } catch {
        if (getGeminiHealthWarning()) break;
      }
    }

    return result;
  }

  async classifyAmbiguousAddressesBatch(uniquePayloads: string[]): Promise<Map<string, GeoClassifyItem>> {
    const result = new Map<string, GeoClassifyItem>();
    if (!this.isConfigured() || uniquePayloads.length === 0) return result;

    const { hits, misses } = await readCacheBatch(
      'GEO_STREET_CLASSIFY',
      this.providerName,
      uniquePayloads,
      GeoClassifyItemSchema
    );
    for (const [k, v] of hits.entries()) result.set(k, v);
    if (misses.length === 0 || getGeminiHealthWarning()) return result;

    const batchSize = 25;
    const ai = this.getClient();

    for (let i = 0; i < misses.length; i += batchSize) {
      if (getGeminiHealthWarning()) break;
      const batch = misses.slice(i, i + batchSize);
      try {
        const response = await this.runWithRetry(() =>
          ai.models.generateContent({
            model: this.model,
            contents: JSON.stringify({
              instruction:
                'Classify each ambiguous address string into geographic hierarchy: suggestedArea, suggestedSubArea, suggestedStreet, groupType (STREET, ROAD, CROSS_STREET, LANE, COLONY, NAGAR_LOCALITY, LAYOUT, SUB_AREA, or UNIDENTIFIED), evidence (exact substring found), confidence (0-1), needsReview (boolean), explanation. Preserve Tamil script and street numbers like Cross 4 vs Cross 5. NEVER invent missing street or area names.',
              addresses: batch,
            }),
            config: {
              systemInstruction:
                'You extract area, sub-area, and street/locality strictly from address evidence. Return UNIDENTIFIED and needsReview=true if evidence is missing.',
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  items: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        input: { type: Type.STRING },
                        suggestedArea: { type: Type.STRING },
                        suggestedSubArea: { type: Type.STRING },
                        suggestedStreet: { type: Type.STRING },
                        groupType: { type: Type.STRING },
                        evidence: { type: Type.STRING },
                        confidence: { type: Type.NUMBER },
                        needsReview: { type: Type.BOOLEAN },
                        explanation: { type: Type.STRING },
                      },
                    },
                  },
                },
              },
            },
          })
        );
        const parsed = JSON.parse((response.text ?? '{}').trim());
        const validated = GeoClassifyBatchSchema.safeParse(parsed);
        if (validated.success) {
          const toCache: Array<{ input: string; value: unknown }> = [];
          for (const item of validated.data.items) {
            result.set(item.input, item);
            toCache.push({ input: item.input, value: item });
          }
          await writeCacheBatch('GEO_STREET_CLASSIFY', this.providerName, toCache);
        }
      } catch {
        if (getGeminiHealthWarning()) break;
      }
    }

    return result;
  }

  async classifyCategoriesBatch(uniqueDescriptions: string[]): Promise<Map<string, CategoryBatchItem>> {
    const result = new Map<string, CategoryBatchItem>();
    if (!this.isConfigured() || uniqueDescriptions.length === 0) return result;

    const { hits, misses } = await readCacheBatch(
      'CATEGORY_CLASSIFY',
      this.providerName,
      uniqueDescriptions,
      CategoryBatchItemSchema
    );
    for (const [k, v] of hits.entries()) result.set(k, v);
    if (misses.length === 0 || getGeminiHealthWarning()) return result;

    const batchSize = 35;
    const ai = this.getClient();

    for (let i = 0; i < misses.length; i += batchSize) {
      if (getGeminiHealthWarning()) break;
      const batch = misses.slice(i, i + batchSize);
      try {
        const response = await this.runWithRetry(() =>
          ai.models.generateContent({
            model: this.model,
            contents: JSON.stringify({
              instruction:
                'Classify each business/customer descriptor into customerType (e.g. Retail, Wholesale, Enterprise, Individual) and businessCategory (e.g. Hardware, Textiles, Medical, Grocery, Services, Logistics). Return null if unclear.',
              inputs: batch,
            }),
            config: {
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  items: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        input: { type: Type.STRING },
                        customerType: { type: Type.STRING },
                        businessCategory: { type: Type.STRING },
                        confidence: { type: Type.NUMBER },
                      },
                    },
                  },
                },
              },
            },
          })
        );
        const parsed = JSON.parse((response.text ?? '{}').trim());
        const validated = CategoryBatchSchema.safeParse(parsed);
        if (validated.success) {
          const toCache: Array<{ input: string; value: unknown }> = [];
          for (const item of validated.data.items) {
            result.set(item.input, item);
            toCache.push({ input: item.input, value: item });
          }
          await writeCacheBatch('CATEGORY_CLASSIFY', this.providerName, toCache);
        }
      } catch {
        if (getGeminiHealthWarning()) break;
      }
    }

    return result;
  }

  async orderLocalitiesByProximityBatch(
    areaName: string,
    places: GeoRoutePlaceInput[]
  ): Promise<string[] | null> {
    if (!this.isConfigured() || places.length < 3 || places.length > 80) return null;

    const sortedSignature = places
      .map((p) => `${p.key}:${p.label}:${p.pins.join(',')}:${p.zones.join(',')}`)
      .sort()
      .join('|');
    const cacheInput = `${areaName.trim().toLowerCase()}::${sortedSignature}`;
    const { hits, misses } = await readCacheBatch(
      'GEO_ROUTE_ORDER',
      this.providerName,
      [cacheInput],
      GeoRouteOrderSchema
    );
    const cached = hits.get(cacheInput);
    if (cached && cached.orderedKeys.length > 0) {
      return cached.orderedKeys;
    }
    if (misses.length === 0 || getGeminiHealthWarning()) return null;

    try {
      const ai = this.getClient();
      const response = await this.runWithRetry(() =>
        ai.models.generateContent({
          model: this.model,
          contents: JSON.stringify({
            instruction:
              'Order all these streets, cross streets, sub-areas, and localities inside the Area as a continuous real-world travelling salesman / nearest-neighbor field visit route. Optimize for actual geographical location, road connectivity, shortest driving distance, and accessibility so a field employee moves smoothly from one street to the nearest adjacent street without backtracking. Never sort alphabetically or randomly. Return EVERY input key exactly once in orderedKeys.',
            areaName,
            places,
          }),
          config: {
            systemInstruction:
              'You are an expert geographical route-optimization planner for field staff. Sequence the provided street/locality keys by true geographical proximity, road connectivity, postal codes, and city zone continuity. Return every input key once.',
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                orderedKeys: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                },
              },
            },
          },
        })
      );
      const parsed = JSON.parse((response.text ?? '{}').trim());
      const validated = GeoRouteOrderSchema.safeParse(parsed);
      if (validated.success && validated.data.orderedKeys.length > 0) {
        await writeCacheBatch('GEO_ROUTE_ORDER', this.providerName, [
          { input: cacheInput, value: validated.data },
        ]);
        return validated.data.orderedKeys;
      }
      return null;
    } catch {
      return null;
    }
  }

  async orderAreasByRouteProximity(
    regionHint: string,
    areas: GeoRouteAreaInput[]
  ): Promise<string[] | null> {
    if (!this.isConfigured() || areas.length < 3 || areas.length > 60) return null;

    const sortedSignature = areas
      .map((a) => `${a.key}:${a.label}:${a.pins.join(',')}:${a.zones.join(',')}`)
      .sort()
      .join('|');
    const cacheInput = `${regionHint.trim().toLowerCase()}::${sortedSignature}`;
    const { hits, misses } = await readCacheBatch(
      'GEO_AREA_ROUTE_ORDER',
      this.providerName,
      [cacheInput],
      GeoRouteOrderSchema
    );
    const cached = hits.get(cacheInput);
    if (cached && cached.orderedKeys.length > 0) {
      return cached.orderedKeys;
    }
    if (misses.length === 0 || getGeminiHealthWarning()) return null;

    try {
      const ai = this.getClient();
      const response = await this.runWithRetry(() =>
        ai.models.generateContent({
          model: this.model,
          contents: JSON.stringify({
            instruction:
              'Sequence these service Areas as a continuous field-staff travel route across the city/district. After finishing all streets in one Area, the field employee should move directly to the geographically nearest neighbouring Area via connected arterial roads, postal zones, and localities to minimize fuel, distance, and backtracking. Never order alphabetically or randomly. Return EVERY input area key exactly once in orderedKeys.',
            regionHint,
            areas,
          }),
          config: {
            systemInstruction:
              'You are a geographic logistics route optimizer. Order the Areas in an efficient contiguous path based on real-world geographical adjacency, road connectivity, PIN codes, and locality corridors. Return every provided key once.',
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                orderedKeys: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                },
              },
            },
          },
        })
      );
      const parsed = JSON.parse((response.text ?? '{}').trim());
      const validated = GeoRouteOrderSchema.safeParse(parsed);
      if (validated.success && validated.data.orderedKeys.length > 0) {
        await writeCacheBatch('GEO_AREA_ROUTE_ORDER', this.providerName, [
          { input: cacheInput, value: validated.data },
        ]);
        return validated.data.orderedKeys;
      }
      return null;
    } catch {
      return null;
    }
  }

  async testConnection() {
    if (!this.isConfigured()) {
      return {
        ok: false,
        provider: 'gemini',
        model: this.model,
        message: 'GEMINI_API_KEY is not configured in Settings > Secrets.',
      };
    }
    resetGeminiCircuitBreaker();
    try {
      const ai = this.getClient();
      const res = await this.runWithRetry(() =>
        ai.models.generateContent({
          model: this.model,
          contents: 'Respond with JSON {"status":"ok"}',
          config: { responseMimeType: 'application/json' },
        })
      );
      return {
        ok: Boolean(res.text),
        provider: 'gemini',
        model: this.model,
        message: 'Connected to Gemini API successfully.',
      };
    } catch (err) {
      const info = classifyGeminiError(err);
      return {
        ok: false,
        provider: 'gemini',
        model: this.model,
        message: info.userMessage,
      };
    }
  }
}

class ClaudeLLMProvider implements LLMProvider {
  public readonly providerName = 'claude' as const;
  private model: string;
  private lastError: string | null = null;

  constructor(model = 'claude-sonnet-4-5') {
    this.model = model;
  }

  isConfigured(): boolean {
    return Boolean(env.anthropicApiKey);
  }

  getLastError(): string | null {
    return this.lastError;
  }

  private async callAnthropic(system: string, userPayload: unknown): Promise<unknown> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.anthropicApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 2048,
        system,
        messages: [{ role: 'user', content: JSON.stringify(userPayload) }],
      }),
    });
    if (!res.ok) {
      throw new Error(`Anthropic API HTTP ${res.status}`);
    }
    const body = (await res.json()) as { content?: Array<{ text?: string }> };
    const text = body.content?.[0]?.text ?? '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    return JSON.parse(jsonMatch ? jsonMatch[0] : text);
  }

  async detectColumnMappings(
    headers: string[],
    sampleRows: Record<string, string>[]
  ): Promise<ColumnDetectionResult | null> {
    if (!this.isConfigured()) return null;
    try {
      const raw = await this.callAnthropic(
        'Return strictly JSON: { "mappings": [{ "sourceIndex": number, "sourceColumn": string, "targetField": string, "confidence": number, "reason": string }] }. Allowed targetField: consumer_id, distributor_id, full_name, address_combined, street, sub_area, area, city, district, state, pin_code, phone_raw, phone_multi, name_and_phone, custom, ignore.',
        { headers, sampleRows: sampleRows.slice(0, 30) }
      );
      const parsed = ColumnDetectionResultSchema.safeParse(raw);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async extractAddressesBatch(uniqueAddresses: string[]): Promise<Map<string, AddressSplitItem>> {
    const result = new Map<string, AddressSplitItem>();
    if (!this.isConfigured() || uniqueAddresses.length === 0) return result;
    const { hits, misses } = await readCacheBatch(
      'ADDRESS_SPLIT',
      this.providerName,
      uniqueAddresses,
      AddressSplitItemSchema
    );
    for (const [k, v] of hits.entries()) result.set(k, v);
    if (misses.length === 0) return result;

    for (let i = 0; i < misses.length; i += 30) {
      const batch = misses.slice(i, i + 30);
      try {
        const raw = await this.callAnthropic(
          'Return strictly JSON: { "items": [{ "input": string, "street": string|null, "area": string|null, "city": string|null, "district": string|null, "state": string|null, "pinCode": string|null, "confidence": number }] }. Never invent missing values.',
          { addresses: batch }
        );
        const parsed = AddressBatchSchema.safeParse(raw);
        if (parsed.success) {
          const toCache: Array<{ input: string; value: unknown }> = [];
          for (const item of parsed.data.items) {
            result.set(item.input, item);
            toCache.push({ input: item.input, value: item });
          }
          await writeCacheBatch('ADDRESS_SPLIT', this.providerName, toCache);
        }
      } catch {
        // Fallback silently to deterministic rules
      }
    }
    return result;
  }

  async classifyAmbiguousAddressesBatch(uniquePayloads: string[]): Promise<Map<string, GeoClassifyItem>> {
    const result = new Map<string, GeoClassifyItem>();
    if (!this.isConfigured() || uniquePayloads.length === 0) return result;
    const { hits, misses } = await readCacheBatch(
      'GEO_STREET_CLASSIFY',
      this.providerName,
      uniquePayloads,
      GeoClassifyItemSchema
    );
    for (const [k, v] of hits.entries()) result.set(k, v);
    if (misses.length === 0) return result;

    for (let i = 0; i < misses.length; i += 25) {
      const batch = misses.slice(i, i + 25);
      try {
        const raw = await this.callAnthropic(
          'Return strictly JSON: { "items": [{ "input": string, "suggestedArea": string|null, "suggestedSubArea": string|null, "suggestedStreet": string|null, "groupType": "STREET"|"ROAD"|"CROSS_STREET"|"LANE"|"COLONY"|"NAGAR_LOCALITY"|"LAYOUT"|"SUB_AREA"|"UNIDENTIFIED", "evidence": string, "confidence": number, "needsReview": boolean, "explanation": string }] }. Never invent missing values.',
          { addresses: batch }
        );
        const parsed = GeoClassifyBatchSchema.safeParse(raw);
        if (parsed.success) {
          const toCache: Array<{ input: string; value: unknown }> = [];
          for (const item of parsed.data.items) {
            result.set(item.input, item);
            toCache.push({ input: item.input, value: item });
          }
          await writeCacheBatch('GEO_STREET_CLASSIFY', this.providerName, toCache);
        }
      } catch {
        // Graceful fallback
      }
    }
    return result;
  }

  async classifyCategoriesBatch(uniqueDescriptions: string[]): Promise<Map<string, CategoryBatchItem>> {
    const result = new Map<string, CategoryBatchItem>();
    if (!this.isConfigured() || uniqueDescriptions.length === 0) return result;
    const { hits, misses } = await readCacheBatch(
      'CATEGORY_CLASSIFY',
      this.providerName,
      uniqueDescriptions,
      CategoryBatchItemSchema
    );
    for (const [k, v] of hits.entries()) result.set(k, v);
    if (misses.length === 0) return result;

    for (let i = 0; i < misses.length; i += 35) {
      const batch = misses.slice(i, i + 35);
      try {
        const raw = await this.callAnthropic(
          'Return strictly JSON: { "items": [{ "input": string, "customerType": string|null, "businessCategory": string|null, "confidence": number }] }.',
          { inputs: batch }
        );
        const parsed = CategoryBatchSchema.safeParse(raw);
        if (parsed.success) {
          const toCache: Array<{ input: string; value: unknown }> = [];
          for (const item of parsed.data.items) {
            result.set(item.input, item);
            toCache.push({ input: item.input, value: item });
          }
          await writeCacheBatch('CATEGORY_CLASSIFY', this.providerName, toCache);
        }
      } catch {
        // Fallback to rules
      }
    }
    return result;
  }

  async orderLocalitiesByProximityBatch(
    areaName: string,
    places: GeoRoutePlaceInput[]
  ): Promise<string[] | null> {
    if (!this.isConfigured() || places.length < 3 || places.length > 80) return null;

    const sortedSignature = places
      .map((p) => `${p.key}:${p.label}:${p.pins.join(',')}:${p.zones.join(',')}`)
      .sort()
      .join('|');
    const cacheInput = `${areaName.trim().toLowerCase()}::${sortedSignature}`;
    const { hits, misses } = await readCacheBatch(
      'GEO_ROUTE_ORDER',
      this.providerName,
      [cacheInput],
      GeoRouteOrderSchema
    );
    const cached = hits.get(cacheInput);
    if (cached && cached.orderedKeys.length > 0) {
      return cached.orderedKeys;
    }
    if (misses.length === 0) return null;

    try {
      const raw = await this.callAnthropic(
        'Return strictly JSON: { "orderedKeys": string[] }. Order the input street/locality keys by true geographical proximity, road connectivity, and shortest travel distance without backtracking. Never sort alphabetically. Return every key once.',
        { areaName, places }
      );
      const parsed = GeoRouteOrderSchema.safeParse(raw);
      if (parsed.success && parsed.data.orderedKeys.length > 0) {
        await writeCacheBatch('GEO_ROUTE_ORDER', this.providerName, [
          { input: cacheInput, value: parsed.data },
        ]);
        return parsed.data.orderedKeys;
      }
      return null;
    } catch {
      return null;
    }
  }

  async orderAreasByRouteProximity(
    regionHint: string,
    areas: GeoRouteAreaInput[]
  ): Promise<string[] | null> {
    if (!this.isConfigured() || areas.length < 3 || areas.length > 60) return null;

    const sortedSignature = areas
      .map((a) => `${a.key}:${a.label}:${a.pins.join(',')}:${a.zones.join(',')}`)
      .sort()
      .join('|');
    const cacheInput = `${regionHint.trim().toLowerCase()}::${sortedSignature}`;
    const { hits, misses } = await readCacheBatch(
      'GEO_AREA_ROUTE_ORDER',
      this.providerName,
      [cacheInput],
      GeoRouteOrderSchema
    );
    const cached = hits.get(cacheInput);
    if (cached && cached.orderedKeys.length > 0) {
      return cached.orderedKeys;
    }
    if (misses.length === 0) return null;

    try {
      const raw = await this.callAnthropic(
        'Return strictly JSON: { "orderedKeys": string[] }. Order the input Areas as a continuous field-staff travel route connecting nearby Areas via road connectivity and postal proximity. Never sort alphabetically. Return every key once.',
        { regionHint, areas }
      );
      const parsed = GeoRouteOrderSchema.safeParse(raw);
      if (parsed.success && parsed.data.orderedKeys.length > 0) {
        await writeCacheBatch('GEO_AREA_ROUTE_ORDER', this.providerName, [
          { input: cacheInput, value: parsed.data },
        ]);
        return parsed.data.orderedKeys;
      }
      return null;
    } catch {
      return null;
    }
  }

  async testConnection() {
    if (!this.isConfigured()) {
      return {
        ok: false,
        provider: 'claude',
        model: this.model,
        message: 'ANTHROPIC_API_KEY is not configured in server secrets.',
      };
    }
    try {
      await this.callAnthropic('Respond with JSON {"status":"ok"}', { ping: true });
      return {
        ok: true,
        provider: 'claude',
        model: this.model,
        message: 'Connected to Anthropic Claude API successfully.',
      };
    } catch (err) {
      return {
        ok: false,
        provider: 'claude',
        model: this.model,
        message: (err as Error).message,
      };
    }
  }
}

class DisabledLLMProvider implements LLMProvider {
  public readonly providerName = 'disabled' as const;
  isConfigured() {
    return false;
  }
  getLastError() {
    return null;
  }
  async detectColumnMappings() {
    return null;
  }
  async extractAddressesBatch() {
    return new Map<string, AddressSplitItem>();
  }
  async classifyAmbiguousAddressesBatch() {
    return new Map<string, GeoClassifyItem>();
  }
  async classifyCategoriesBatch() {
    return new Map<string, CategoryBatchItem>();
  }
  async orderLocalitiesByProximityBatch() {
    return null;
  }
  async orderAreasByRouteProximity() {
    return null;
  }
  async testConnection() {
    return {
      ok: false,
      provider: 'disabled',
      model: 'none',
      message: 'AI provider is disabled in Workspace Settings (running deterministic rules only).',
    };
  }
}

export async function getActiveLLMProvider(): Promise<LLMProvider> {
  const db = getDb();
  let providerSetting = 'gemini';
  let geminiModel = 'gemini-4-hydrogen';
  let claudeModel = 'claude-sonnet-4-5';

  try {
    const res = await db.query<{ key: string; value: unknown }>(
      `SELECT key, value FROM settings WHERE key IN ('llm.provider', 'llm.gemini_model', 'llm.claude_model')`
    );
    for (const row of res.rows) {
      if (row.key === 'llm.provider' && typeof row.value === 'string') providerSetting = row.value;
      if (row.key === 'llm.gemini_model' && typeof row.value === 'string') geminiModel = row.value;
      if (row.key === 'llm.claude_model' && typeof row.value === 'string') claudeModel = row.value;
    }
  } catch {
    // Use defaults
  }

  if (providerSetting === 'claude') {
    const claude = new ClaudeLLMProvider(claudeModel);
    if (claude.isConfigured()) return claude;
  }
  if (providerSetting === 'gemini') {
    const gemini = new GeminiLLMProvider(geminiModel);
    if (gemini.isConfigured()) return gemini;
  }
  if (providerSetting === 'disabled') {
    return new DisabledLLMProvider();
  }
  // Fallback if selected key isn't configured
  const gemini = new GeminiLLMProvider(geminiModel);
  if (gemini.isConfigured()) return gemini;
  const claude = new ClaudeLLMProvider(claudeModel);
  if (claude.isConfigured()) return claude;
  return new DisabledLLMProvider();
}
