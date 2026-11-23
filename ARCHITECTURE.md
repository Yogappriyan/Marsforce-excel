# StructIQ — System Architecture & Technical Specification

> **Document Scope:** Phase 1 Architecture Blueprint for **StructIQ**, an independent, production-grade AI Data Structuring Platform engineered to ingest, parse, extract, standardise, categorise, deduplicate, human-review, store, search, and export datasets of **1,000 to 100,000+ records**.

---

## 1. Assumptions and Open Questions

Every ambiguity in requirements has been documented below with a recommended production default that the architecture adopts.

| # | Area | Open Question / Ambiguity | Recommended Default | Rationale |
|---|---|---|---|---|
| 1 | **Database Access Layer** | Should we use Prisma ORM or `pg` with versioned SQL migrations? | **`pg` (`node-postgres`) + versioned SQL migrations (`migrations/*.sql`)** | Avoids Prisma binary/engine cold-start or container compatibility issues in constrained runtimes, gives full native control over `pg_trgm` GIN indexes, `FOR UPDATE SKIP LOCKED` job claiming, `COPY`/batched `unnest` bulk inserts for 100k rows, and strict parameterized queries. |
| 2 | **Default Phone & Postal Region** | Should phone and PIN parsing hardcode India (`IN`) or support multi-region? | **Configurable default `IN` (India) stored in `settings`** (`default_phone_region = "IN"`, 6-digit PIN `110001–855117`) | Meets Indian mobile (`^[6-9]\d{9}$`, `+91` / `0` stripping) and 6-digit PIN requirements out of the box while allowing Admins to change region per workspace/setting. |
| 3 | **PIN-to-District/State Lookup** | How should missing City/District/State be inferred from a 6-digit PIN without external API latency/cost at 100k rows? | **Local offline Indian PIN prefix / postal directory lookup table** (or embedded static prefix map) | Zero external network calls at 100k rows; deterministic; any field populated from PIN lookup is strictly tagged `provenance = "INFERRED"` and automatically flagged `NEEDS_REVIEW`. |
| 4 | **Multi-Tenancy** | Is StructIQ single-organisation (internal enterprise deployment) or multi-tenant SaaS? | **Single-organisation deployment with strict RBAC** | Matches standalone company deployment with Super Admin seeding, global record search, and shared mapping/category rules. Can add `org_id` cleanly later if needed. |
| 5 | **AI Provider & PII Minimization** | What data is safe to send to Gemini / Claude, and which models should be used? | **Send headers + 30 sampled rows (with optional PII masking for phone/email tokens) for schema mapping; send only unique ambiguous address/category strings in batches of 25–50.** Default Gemini model: `gemini-4-hydrogen` (`@google/genai`); optional Claude: `claude-sonnet-4-5` (or configured model ID). | Controls token cost at 100k rows, keeps raw PII out of bulk LLM prompts, and falls back to deterministic rules if no API key is configured or LLM output fails Zod validation. |
| 6 | **Storage Adapter Default** | What happens in local/dev environments where `GCS_BUCKET` is not configured? | **`StorageAdapter` selects `GCSStorageAdapter` when `GCS_BUCKET` + `GCS_SERVICE_ACCOUNT_JSON` are present, and falls back to `LocalDiskStorageAdapter` (explicitly labelled `DEV ONLY` in logs/settings) only when `NODE_ENV !== 'production'`.** | Prevents accidental local-disk usage in production while allowing full end-to-end verification in development. |
| 7 | **Duplicate Scope** | Should duplicate detection check within the same upload only, or also against previously `APPROVED` master records? | **Configurable per processing job; default = Within Upload + Against Approved Master Records** | Prevents re-importing existing customers across batches while keeping blocking fast via indexed `phone_e164` and `pin_code` lookups. |
| 8 | **Duplicate Auto-Merge Threshold** | Should exact duplicates be merged automatically? | **Never auto-delete or auto-merge.** Exact matches (`score === 1.0`) are grouped as `POTENTIAL_DUPLICATE` with a one-click "Accept Suggested Merge" action; all merges require explicit user approval and are reversible via `record_history`. | Satisfies the non-negotiable principle: uncertain or automated merges never silently discard records. |
| 9 | **Session & Refresh Token Strategy** | How should browser sessions remain secure across iFrame and standalone deployments? | **Opaque cryptographically random session + refresh tokens stored hashed (SHA-256) in PostgreSQL `sessions` table, delivered via `httpOnly`, `SameSite=Lax` (or `None; Secure` when cross-origin HTTPS), `Secure` cookies.** | Supports immediate server-side revocation, role-change invalidation, and refresh rotation without JWT revocation gaps. |
| 10 | **Retention & Purge Defaults** | What are the default retention periods for uploads, raw records, exports, and audit logs? | **Uploads/Raw/Clean soft-delete retention: 365 days (configurable); Export artifacts: 30 days; Audit logs: 7 years (immutable).** | Balances storage hygiene with enterprise compliance; permanent purge requires `Super Admin`. |
| 11 | **Indic / Tamil Script Phonetic Matching** | Standard Soundex/Metaphone only handles ASCII Latin characters. How do we handle Tamil/Indic script names? | **Dual strategy: Unicode NFC normalization + transliteration-aware normalization for Latin variants (`ph/f`, `v/w`, `th/t`, double vowels `aa/a`, `ee/i`, `oo/u`) + Jaro-Winkler on normalized tokens.** | Improves fuzzy matching for transliterated South Indian names (e.g., `Karthik` / `Karthick`, `Suresh` / `Suresh Kumar`) without corrupting native Tamil script (`தமிழ்`) stored in clean fields. |

---

## 2. System Architecture & Module Breakdown

### 2.1 High-Level Architecture Diagram

```mermaid
flowchart TB
    subgraph Client["Frontend SPA (React 19 + TypeScript + Vite + Tailwind CSS)"]
        UI_Auth["Auth & Session Guard"]
        UI_Dash["Pipeline Dashboard & Upload Wizard"]
        UI_Map["Schema Mapper & Template Editor"]
        UI_Rev["Virtualised Review Grid (100k+ rows)"]
        UI_Dup["Side-by-Side Duplicate Merge UI"]
        UI_Cat["Categorisation Rule Builder"]
        UI_Exp["Exports & Audit / Admin Consoles"]
        API_Client["Typed API Client (VITE_API_BASE_URL)"]
    end

    subgraph Server["Backend API & Worker Runtime (Node.js + Express + TypeScript)"]
        direction TB
        MW["Security & Cross-Cutting Middleware\n(Helmet · CORS · RateLimit · Cookie Auth · RBAC · Zod · Error Handler)"]
        
        subgraph Modules["Domain Modules (routes → service → repository)"]
            M_Auth["auth"]
            M_Users["users"]
            M_Uploads["uploads"]
            M_Jobs["jobs"]
            M_Proc["processing"]
            M_Cat["categorisation"]
            M_Dup["duplicates"]
            M_Rec["records"]
            M_Exp["exports"]
            M_Audit["audit"]
            M_Set["settings"]
        end

        subgraph Interfaces["Pluggable Infrastructure Adapters"]
            I_Queue["JobWorkerInterface\n(PostgresChunkWorker)"]
            I_LLM["LLMProvider\n(GeminiProvider | ClaudeProvider)"]
            I_Store["StorageAdapter\n(GCSStorageAdapter | DevLocalDiskAdapter)"]
        end
    end

    subgraph Data["Persistence & External Services"]
        PG[("PostgreSQL 16+\n(pg_trgm · JSONB · SKIP LOCKED Queue)")]
        GCS[("Google Cloud Storage\n(Immutable Uploads & Exports)")]
        Gemini["Google Gemini API\n(@google/genai: gemini-4-hydrogen)"]
        Claude["Anthropic Claude API\n(Optional via Settings)"]
    end

    Client -->|"HTTPS + httpOnly Cookies\nREST JSON / File Multipart / SSE"| MW
    MW --> Modules
    M_Uploads --> I_Store
    M_Exp --> I_Store
    M_Uploads --> M_Jobs
    M_Exp --> M_Jobs
    M_Proc --> I_LLM
    M_Cat --> I_LLM
    I_Queue -->|"Claims chunks via SKIP LOCKED"| PG
    I_Queue --> M_Proc
    I_Queue --> M_Cat
    I_Queue --> M_Dup
    I_Queue --> M_Exp
    Modules --> PG
    I_Store --> GCS
    I_LLM --> Gemini
    I_LLM --> Claude
```

### 2.2 Folder Separation & Module Responsibilities

Frontend and backend live in cleanly separated directories so the frontend can be built and hosted independently (pointing at `VITE_API_BASE_URL`), while running seamlessly under Express + Vite middleware in development and single-container production.

```text
/
├── src/                          # Frontend React SPA (independent buildable client)
│   ├── api/                      # Fetch client using VITE_API_BASE_URL + credentials: 'include'
│   ├── components/               # Reusable UI primitives, virtualised table, layout shell
│   ├── contexts/                 # AuthContext, ThemeContext (light/dark), ToastContext
│   ├── features/                 # Feature views: upload, mapping, review, duplicates, rules, exports, admin
│   ├── hooks/                    # Keyboard shortcuts, polling/SSE, pagination hooks
│   └── types/                    # Shared API DTO types
├── server/                       # Backend Express + Worker runtime
│   ├── app.ts                    # Express app factory, security middleware, route mounting
│   ├── server.ts                 # Entrypoint (DB healthcheck, Super Admin seed, worker start, Vite/static)
│   ├── config/                   # Validated env config (Zod)
│   ├── middleware/               # authGuard, requirePermission(perm), rateLimiters, validateRequest
│   ├── infrastructure/
│   │   ├── db/                   # pg Pool, transaction helper, migration runner
│   │   ├── storage/              # StorageAdapter interface, GCSStorageAdapter, LocalDiskStorageAdapter
│   │   ├── llm/                  # LLMProvider interface, GeminiProvider, ClaudeProvider, llmCache
│   │   └── queue/                # JobWorkerInterface, PostgresJobQueue, chunkProcessor, reaper
│   └── modules/                  # Strictly layered: *.routes.ts -> *.service.ts -> *.repository.ts
│       ├── auth/
│       ├── users/
│       ├── uploads/
│       ├── jobs/
│       ├── processing/           # Parse, map, extract, clean, validate stages
│       ├── categorisation/
│       ├── duplicates/
│       ├── records/
│       ├── exports/
│       ├── audit/
│       └── settings/
├── migrations/                   # Versioned SQL migrations (001_init.sql, ...)
├── ARCHITECTURE.md
├── .env.example
└── package.json
```

### 2.3 Backend Module Breakdown (`routes -> service -> repository`)

| Module | Routes (HTTP boundary + Zod validation) | Service (Business rules + Orchestration) | Repository (Parameterized SQL) |
|---|---|---|---|
| `auth` | Login, logout, refresh, current user `/me`, change password | Argon2id password verify, policy check, lockout counter, session/refresh token rotation, audit emit | `users`, `sessions`, `role_permissions`, `audit_logs` |
| `users` | List, create, update, deactivate/reactivate, reset lock | Enforce Super Admin boundary (Admins cannot touch Super Admins), emit audit log | `users`, `roles`, `sessions` |
| `uploads` | Multipart upload, preview sheet/50 rows, duplicate check, override, history | Magic-byte/MIME/zip-bomb checks, SHA-256 hash, SheetJS/csv-parse header & sample inspect, store raw file via `StorageAdapter` | `uploads`, `upload_sheets`, `raw_records` |
| `jobs` | Get job status/chunks, SSE progress stream, cancel job, retry dead-letter job | Enqueue jobs, compute progress %, transition `CANCELLED`, schedule retry | `jobs`, `job_chunks` |
| `processing` | Save column mappings, CRUD mapping templates, start processing job | Rule + LLM schema detection, chunk execution (extract, clean, validate), provenance & issue generation, cache lookup | `column_mappings`, `mapping_templates`, `raw_records`, `clean_records`, `llm_value_cache` |
| `categorisation` | CRUD category rules, test rule, run re-categorisation, list category tree | Priority-ordered rule evaluation, hierarchical `State > District > City > Street` builder, batched LLM fallback | `category_rules`, `record_categories`, `clean_records` |
| `duplicates` | List duplicate groups, compare members, merge records, dismiss, revert merge | Blocking key generation (`phone_e164`, `pin_code`, city+phonetic), Jaro-Winkler/Levenshtein scoring, reversible field-level merge | `duplicate_groups`, `duplicate_members`, `clean_records`, `record_history` |
| `records` | Search/filter/sort paginated records, get record + history, inline edit, bulk edit, approve/reject, soft delete/purge | Server-side query builder, provenance update (`MANUAL` edit history), approval state machine, retention enforcement | `clean_records`, `raw_records`, `record_history`, `record_categories` |
| `exports` | Request export (XLSX/CSV), list export history, download artifact | Stream small exports or enqueue background job for large exports, ExcelJS formula neutralization, multi-sheet split | `exports`, `clean_records`, `raw_records`, `jobs` |
| `audit` | Query audit logs, activity summary | Filterable query construction, redaction guarantees | `audit_logs` |
| `settings` | Get/update workspace settings, test LLM connection | Validate setting schemas, enforce Admin/Super Admin permissions, audit config changes | `settings` |

---

## 3. PostgreSQL Schema

### 3.1 Entity Relationship Diagram

```mermaid
erDiagram
    users ||--o{ sessions : has
    users ||--o{ uploads : creates
    users ||--o{ exports : requests
    users ||--o{ audit_logs : performs
    roles ||--o{ role_permissions : grants
    permissions ||--o{ role_permissions : included_in
    roles ||--o{ users : assigned_to

    uploads ||--o{ upload_sheets : contains
    uploads ||--o{ jobs : spawns
    uploads ||--o{ raw_records : ingests
    upload_sheets ||--o{ column_mappings : defines
    mapping_templates ||--o{ column_mappings : referenced_by

    jobs ||--o{ job_chunks : splits_into
    jobs ||--o| exports : produces

    raw_records ||--o| clean_records : transforms_to
    clean_records ||--o{ record_categories : tagged_with
    category_rules ||--o{ record_categories : produces
    clean_records ||--o{ duplicate_members : participates_in
    duplicate_groups ||--o{ duplicate_members : aggregates
    clean_records ||--o{ record_history : tracks
```

### 3.2 Extensions & Enums

Required extensions:
- `pgcrypto` (for `gen_random_uuid()`)
- `pg_trgm` (for trigram GIN fuzzy search on names, streets, cities, districts)

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TYPE user_role AS ENUM (
  'SUPER_ADMIN',
  'ADMIN',
  'DATA_PROCESSOR',
  'REVIEWER',
  'READ_ONLY'
);

CREATE TYPE upload_status AS ENUM (
  'UPLOADED',
  'PARSING_PREVIEW',
  'READY_TO_MAP',
  'MAPPED',
  'PROCESSING',
  'PROCESSED',
  'FAILED',
  'DELETED'
);

CREATE TYPE job_type AS ENUM (
  'INGEST_AND_PROCESS',
  'REPROCESS_CATEGORISE',
  'DETECT_DUPLICATES',
  'EXPORT_DATASET',
  'RETENTION_PURGE'
);

CREATE TYPE job_status AS ENUM (
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'CANCEL_REQUESTED',
  'CANCELLED',
  'FAILED_DEAD_LETTER'
);

CREATE TYPE chunk_status AS ENUM (
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'RETRY_SCHEDULED',
  'DEAD_LETTER',
  'CANCELLED'
);

CREATE TYPE field_provenance AS ENUM (
  'EXTRACTED',
  'STANDARDISED',
  'INFERRED'
);

CREATE TYPE record_status AS ENUM (
  'PROCESSED',
  'VERIFIED',
  'NEEDS_REVIEW',
  'INVALID',
  'POTENTIAL_DUPLICATE',
  'APPROVED',
  'REJECTED'
);

CREATE TYPE duplicate_status AS ENUM (
  'PENDING',
  'MERGED',
  'DISMISSED',
  'REVERTED'
);

CREATE TYPE export_format AS ENUM ('XLSX', 'CSV');
CREATE TYPE export_status AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'EXPIRED');
```

### 3.3 Core Tables, Columns, Indexes & Constraints

#### A. Authentication & RBAC

1. **`roles` & `permissions` & `role_permissions`**
   - `roles`: `name user_role PRIMARY KEY`, `description TEXT NOT NULL`
   - `permissions`: `code TEXT PRIMARY KEY` (`upload`, `process`, `edit`, `approve`, `export`, `manage_users`, `manage_settings`, `delete`, `view`), `description TEXT NOT NULL`
   - `role_permissions`: `role user_role REFERENCES roles(name) ON DELETE CASCADE`, `permission TEXT REFERENCES permissions(code) ON DELETE CASCADE`, `PRIMARY KEY (role, permission)`

   **Permission Matrix:**
   | Role | `view` | `upload` | `process` | `edit` | `approve` | `export` | `manage_users` | `manage_settings` | `delete` |
   |---|---|---|---|---|---|---|---|---|---|
   | `SUPER_ADMIN` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (all) | ✓ | ✓ (soft + permanent purge) |
   | `ADMIN` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (non-SuperAdmin) | ✓ | ✓ (soft delete only) |
   | `DATA_PROCESSOR` | ✓ | ✓ | ✓ | ✓ | — | ✓ | — | — | — |
   | `REVIEWER` | ✓ | — | — | ✓ | ✓ | — | — | — | — |
   | `READ_ONLY` | ✓ | — | — | — | — | — | — | — | — |

2. **`users`**
   - `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
   - `email TEXT UNIQUE NOT NULL` (stored lowercased & trimmed)
   - `full_name TEXT NOT NULL`
   - `password_hash TEXT NOT NULL` (Argon2id)
   - `role user_role NOT NULL DEFAULT 'READ_ONLY'`
   - `is_active BOOLEAN NOT NULL DEFAULT true`
   - `failed_login_attempts INT NOT NULL DEFAULT 0`
   - `locked_until TIMESTAMPTZ`
   - `last_login_at TIMESTAMPTZ`
   - `password_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
   - `created_by UUID REFERENCES users(id)`
   - `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
   - `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
   - Indexes: `idx_users_role` on `(role)`, `idx_users_active` on `(is_active)`.

3. **`sessions`**
   - `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
   - `user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE`
   - `session_token_hash TEXT UNIQUE NOT NULL` (SHA-256 of opaque token)
   - `refresh_token_hash TEXT UNIQUE NOT NULL`
   - `token_family_id UUID NOT NULL` (detects refresh token replay)
   - `ip_address INET`
   - `user_agent TEXT`
   - `expires_at TIMESTAMPTZ NOT NULL`
   - `refresh_expires_at TIMESTAMPTZ NOT NULL`
   - `revoked_at TIMESTAMPTZ`
   - `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
   - Indexes: `idx_sessions_user_active` on `(user_id) WHERE revoked_at IS NULL`, `idx_sessions_expires` on `(expires_at)`.

#### B. Ingestion, Mapping & Templates

4. **`uploads`**
   - `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
   - `uploaded_by UUID NOT NULL REFERENCES users(id)`
   - `original_filename TEXT NOT NULL`
   - `mime_type TEXT NOT NULL`
   - `file_extension TEXT NOT NULL`
   - `file_size_bytes BIGINT NOT NULL`
   - `file_sha256 CHAR(64) NOT NULL`
   - `storage_driver TEXT NOT NULL` (`GCS` | `LOCAL_DEV`)
   - `storage_key TEXT NOT NULL` (immutable original file path/object key)
   - `detected_encoding TEXT` (`UTF-8`, `UTF-16LE`, `UTF-16BE`, `WINDOWS-1252`)
   - `is_duplicate_override BOOLEAN NOT NULL DEFAULT false`
   - `duplicate_of_upload_id UUID REFERENCES uploads(id)`
   - `status upload_status NOT NULL DEFAULT 'UPLOADED'`
   - `error_code TEXT`
   - `error_message TEXT`
   - `total_rows INT NOT NULL DEFAULT 0`
   - `deleted_at TIMESTAMPTZ`
   - `retention_until TIMESTAMPTZ`
   - `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
   - `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
   - Indexes: `idx_uploads_sha256` on `(file_sha256) WHERE deleted_at IS NULL`, `idx_uploads_created` on `(created_at DESC)`.

5. **`upload_sheets`**
   - `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
   - `upload_id UUID NOT NULL REFERENCES uploads(id) ON DELETE CASCADE`
   - `sheet_index INT NOT NULL`
   - `sheet_name TEXT NOT NULL`
   - `row_count INT NOT NULL`
   - `column_count INT NOT NULL`
   - `headers JSONB NOT NULL` (`[{ index, rawName, normalizedName, inferredType, sampleValues }]`)
   - `preview_rows JSONB NOT NULL` (first 50 rows for fast preview UI)
   - `is_selected BOOLEAN NOT NULL DEFAULT false`
   - `selected_columns JSONB` (array of source column names/indices)
   - `UNIQUE (upload_id, sheet_index)`

6. **`mapping_templates`**
   - `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
   - `name TEXT UNIQUE NOT NULL`
   - `description TEXT`
   - `header_signature CHAR(64)` (SHA-256 of sorted normalized headers for auto-suggestion)
   - `mappings JSONB NOT NULL` (`[{ sourceHeaderPattern, targetField, splitStrategy }]`)
   - `created_by UUID NOT NULL REFERENCES users(id)`
   - `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
   - `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
   - Indexes: `idx_mapping_templates_sig` on `(header_signature)`.

7. **`column_mappings`**
   - `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
   - `upload_id UUID NOT NULL REFERENCES uploads(id) ON DELETE CASCADE`
   - `sheet_id UUID NOT NULL REFERENCES upload_sheets(id) ON DELETE CASCADE`
   - `source_column TEXT NOT NULL`
   - `source_index INT NOT NULL`
   - `target_field TEXT NOT NULL` (`full_name | address_combined | street | area | city | district | state | pin_code | phone_raw | phone_multi | name_and_phone | custom | ignore`)
   - `custom_field_key TEXT`
   - `detection_source TEXT NOT NULL` (`RULE | AI | TEMPLATE | MANUAL`)
   - `confidence NUMERIC(4,3) NOT NULL DEFAULT 1.000`
   - `template_id UUID REFERENCES mapping_templates(id) ON DELETE SET NULL`
   - `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
   - `UNIQUE (sheet_id, source_index)`

#### C. Background Job Queue

8. **`jobs`**
   - `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
   - `job_type job_type NOT NULL`
   - `status job_status NOT NULL DEFAULT 'QUEUED'`
   - `upload_id UUID REFERENCES uploads(id) ON DELETE CASCADE`
   - `sheet_id UUID REFERENCES upload_sheets(id) ON DELETE SET NULL`
   - `created_by UUID NOT NULL REFERENCES users(id)`
   - `payload JSONB NOT NULL DEFAULT '{}'`
   - `total_records INT NOT NULL DEFAULT 0`
   - `processed_records INT NOT NULL DEFAULT 0`
   - `failed_records INT NOT NULL DEFAULT 0`
   - `total_chunks INT NOT NULL DEFAULT 0`
   - `completed_chunks INT NOT NULL DEFAULT 0`
   - `cancel_requested BOOLEAN NOT NULL DEFAULT false`
   - `error_summary TEXT`
   - `started_at TIMESTAMPTZ`
   - `completed_at TIMESTAMPTZ`
   - `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
   - `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
   - Indexes: `idx_jobs_status_created` on `(status, created_at)`, `idx_jobs_upload` on `(upload_id)`.

9. **`job_chunks`**
   - `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
   - `job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE`
   - `chunk_index INT NOT NULL`
   - `row_start INT NOT NULL`
   - `row_end INT NOT NULL`
   - `status chunk_status NOT NULL DEFAULT 'PENDING'`
   - `attempt_count INT NOT NULL DEFAULT 0`
   - `max_attempts INT NOT NULL DEFAULT 5`
   - `next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
   - `locked_by TEXT` (worker instance ID)
   - `locked_at TIMESTAMPTZ`
   - `heartbeat_at TIMESTAMPTZ`
   - `last_error_code TEXT`
   - `last_error_message TEXT`
   - `completed_at TIMESTAMPTZ`
   - `UNIQUE (job_id, chunk_index)`
   - Indexes: `idx_job_chunks_claim` on `(status, next_retry_at) WHERE status IN ('PENDING', 'RETRY_SCHEDULED')`, `idx_job_chunks_stale` on `(locked_at, heartbeat_at) WHERE status = 'RUNNING'`.

#### D. Records (Immutable Raw vs Structured Clean)

10. **`raw_records`** *(Immutable source of truth — application role has no `UPDATE` on `raw_data`)*
    - `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
    - `upload_id UUID NOT NULL REFERENCES uploads(id) ON DELETE CASCADE`
    - `sheet_id UUID NOT NULL REFERENCES upload_sheets(id) ON DELETE CASCADE`
    - `row_number INT NOT NULL`
    - `row_fingerprint CHAR(64) NOT NULL` (SHA-256 of canonicalized row values for duplicate import detection)
    - `raw_data JSONB NOT NULL` (exact parsed source cells keyed by original header)
    - `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
    - `UNIQUE (sheet_id, row_number)`
    - Indexes: `idx_raw_records_upload` on `(upload_id, row_number)`, `idx_raw_records_fingerprint` on `(row_fingerprint)`.

11. **`clean_records`**
    - `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
    - `raw_record_id UUID UNIQUE NOT NULL REFERENCES raw_records(id) ON DELETE CASCADE`
    - `upload_id UUID NOT NULL REFERENCES uploads(id) ON DELETE CASCADE`
    - `full_name TEXT`
    - `normalized_name TEXT` (lowercased, punctuation-stripped for blocking/matching)
    - `street TEXT`
    - `area TEXT`
    - `city TEXT`
    - `district TEXT`
    - `state TEXT`
    - `pin_code VARCHAR(6)`
    - `phone_e164 VARCHAR(20)` (primary standardized phone, e.g. `+919876543210`)
    - `phone_display VARCHAR(24)` (e.g. `+91 98765 43210`)
    - `secondary_phones JSONB NOT NULL DEFAULT '[]'` (`[{ e164, display, raw, valid }]`)
    - `other_fields JSONB NOT NULL DEFAULT '{}'` (mapped extra/custom columns)
    - `provenance JSONB NOT NULL DEFAULT '{}'` (`{ "full_name": "EXTRACTED", "phone_e164": "STANDARDISED", "district": "INFERRED" }`)
    - `field_confidence JSONB NOT NULL DEFAULT '{}'` (`{ "full_name": 0.98, "city": 0.86 }`)
    - `overall_confidence NUMERIC(4,3) NOT NULL DEFAULT 0.000`
    - `status record_status NOT NULL DEFAULT 'PROCESSED'`
    - `has_inferred_fields BOOLEAN NOT NULL DEFAULT false`
    - `issues JSONB NOT NULL DEFAULT '[]'` (`[{ "code": "INVALID_PHONE", "field": "phone_e164", "severity": "ERROR", "message": "Phone number must be 10 digits starting with 6-9 for IN region." }]`)
    - `is_merged BOOLEAN NOT NULL DEFAULT false`
    - `merged_into_id UUID REFERENCES clean_records(id) ON DELETE SET NULL`
    - `approved_by UUID REFERENCES users(id)`
    - `approved_at TIMESTAMPTZ`
    - `deleted_at TIMESTAMPTZ`
    - `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
    - `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
    - **Indexes:**
      - `idx_clean_records_status` on `(status, upload_id) WHERE deleted_at IS NULL`
      - `idx_clean_records_phone` on `(phone_e164) WHERE deleted_at IS NULL AND phone_e164 IS NOT NULL`
      - `idx_clean_records_pin` on `(pin_code) WHERE deleted_at IS NULL AND pin_code IS NOT NULL`
      - `idx_clean_records_city_dist` on `(city, district, state) WHERE deleted_at IS NULL`
      - `idx_clean_records_approved` on `(approved_at DESC) WHERE status = 'APPROVED' AND deleted_at IS NULL`
      - **GIN Trigram Indexes (`pg_trgm`)**:
        - `idx_clean_records_name_trgm` USING GIN (`full_name gin_trgm_ops`)
        - `idx_clean_records_street_trgm` USING GIN (`street gin_trgm_ops`)
        - `idx_clean_records_city_trgm` USING GIN (`city gin_trgm_ops`)
        - `idx_clean_records_district_trgm` USING GIN (`district gin_trgm_ops`)

#### E. Categorisation & Hierarchy

12. **`category_rules`**
    - `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
    - `name TEXT NOT NULL`
    - `priority INT NOT NULL DEFAULT 100` (lower number = higher priority)
    - `category_type TEXT NOT NULL` (`LOCATION_STATE | LOCATION_DISTRICT | LOCATION_CITY | LOCATION_STREET | CUSTOMER_TYPE | BUSINESS_CATEGORY | CUSTOM`)
    - `category_value TEXT NOT NULL`
    - `parent_rule_id UUID REFERENCES category_rules(id) ON DELETE SET NULL`
    - `conditions JSONB NOT NULL` (`{ operator: "AND"|"OR", clauses: [{ field, matchType: "EQUALS"|"CONTAINS"|"REGEX"|"IN", value }] }`)
    - `is_active BOOLEAN NOT NULL DEFAULT true`
    - `created_by UUID NOT NULL REFERENCES users(id)`
    - `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
    - `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
    - Indexes: `idx_category_rules_priority` on `(priority ASC) WHERE is_active = true`.

13. **`record_categories`**
    - `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
    - `clean_record_id UUID NOT NULL REFERENCES clean_records(id) ON DELETE CASCADE`
    - `category_type TEXT NOT NULL`
    - `category_value TEXT NOT NULL`
    - `hierarchy_path TEXT` (e.g. `Tamil Nadu > Madurai > Anna Nagar > Main Road`)
    - `rule_id UUID REFERENCES category_rules(id) ON DELETE SET NULL`
    - `source TEXT NOT NULL` (`RULE | AI | MANUAL | LOCATION_HIERARCHY`)
    - `confidence NUMERIC(4,3) NOT NULL DEFAULT 1.000`
    - `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
    - `UNIQUE (clean_record_id, category_type, category_value)`
    - Indexes: `idx_record_categories_lookup` on `(category_type, category_value, clean_record_id)`, `idx_record_categories_path` on `(hierarchy_path)`.

#### F. Duplicates & Record Version History

14. **`duplicate_groups`**
    - `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
    - `upload_id UUID REFERENCES uploads(id) ON DELETE CASCADE`
    - `match_type TEXT NOT NULL` (`EXACT_FINGERPRINT | SAME_PHONE_DIFF_NAME | FUZZY_NAME_ADDRESS | CROSS_UPLOAD_MASTER`)
    - `confidence NUMERIC(4,3) NOT NULL`
    - `status duplicate_status NOT NULL DEFAULT 'PENDING'`
    - `surviving_record_id UUID REFERENCES clean_records(id) ON DELETE SET NULL`
    - `resolved_by UUID REFERENCES users(id)`
    - `resolved_at TIMESTAMPTZ`
    - `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
    - Indexes: `idx_dup_groups_status` on `(status, upload_id)`.

15. **`duplicate_members`**
    - `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
    - `group_id UUID NOT NULL REFERENCES duplicate_groups(id) ON DELETE CASCADE`
    - `clean_record_id UUID NOT NULL REFERENCES clean_records(id) ON DELETE CASCADE`
    - `match_score NUMERIC(4,3) NOT NULL`
    - `match_reasons JSONB NOT NULL` (`["PHONE_EXACT_MATCH", "NAME_JARO_WINKLER_0.91"]`)
    - `is_suggested_primary BOOLEAN NOT NULL DEFAULT false`
    - `UNIQUE (group_id, clean_record_id)`
    - Indexes: `idx_dup_members_record` on `(clean_record_id)`.

16. **`record_history`** *(Immutable version history enabling field audit and reversible merges)*
    - `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
    - `clean_record_id UUID NOT NULL REFERENCES clean_records(id) ON DELETE CASCADE`
    - `action TEXT NOT NULL` (`CREATED | INLINE_EDIT | BULK_EDIT | APPROVED | REJECTED | MERGED | MERGE_REVERTED | SOFT_DELETED | RESTORED`)
    - `before_state JSONB`
    - `after_state JSONB NOT NULL`
    - `changed_fields TEXT[] NOT NULL DEFAULT '{}'`
    - `duplicate_group_id UUID REFERENCES duplicate_groups(id) ON DELETE SET NULL`
    - `revert_of_history_id UUID REFERENCES record_history(id)`
    - `actor_id UUID REFERENCES users(id)`
    - `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
    - Indexes: `idx_record_history_record` on `(clean_record_id, created_at DESC)`.

#### G. Exports, Audit, Settings & LLM Cache

17. **`exports`**
    - `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
    - `job_id UUID REFERENCES jobs(id) ON DELETE SET NULL`
    - `requested_by UUID NOT NULL REFERENCES users(id)`
    - `format export_format NOT NULL`
    - `filename TEXT NOT NULL`
    - `filters JSONB NOT NULL DEFAULT '{}'`
    - `column_order JSONB NOT NULL`
    - `split_by TEXT` (`NONE | CITY | DISTRICT | STATE | CATEGORY`)
    - `include_original_sheet BOOLEAN NOT NULL DEFAULT true`
    - `status export_status NOT NULL DEFAULT 'QUEUED'`
    - `row_count INT NOT NULL DEFAULT 0`
    - `file_size_bytes BIGINT`
    - `storage_driver TEXT`
    - `storage_key TEXT`
    - `expires_at TIMESTAMPTZ`
    - `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
    - Indexes: `idx_exports_user_created` on `(requested_by, created_at DESC)`.

18. **`audit_logs`** *(Append-only; never stores raw PII values — records IDs, field names changed, and action codes)*
    - `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
    - `actor_id UUID REFERENCES users(id) ON DELETE SET NULL`
    - `actor_role user_role`
    - `action TEXT NOT NULL` (`AUTH_LOGIN_SUCCESS | AUTH_LOGIN_FAIL | AUTH_LOCKOUT | USER_CREATE | UPLOAD_CREATE | UPLOAD_DUPLICATE_OVERRIDE | JOB_CANCEL | RECORD_APPROVE | RECORD_BULK_EDIT | DUPLICATE_MERGE | DUPLICATE_REVERT | EXPORT_DOWNLOAD | RETENTION_PURGE | SETTINGS_UPDATE`)
    - `resource_type TEXT NOT NULL`
    - `resource_id TEXT`
    - `ip_address INET`
    - `user_agent TEXT`
    - `metadata JSONB NOT NULL DEFAULT '{}'`
    - `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
    - Indexes: `idx_audit_logs_created` on `(created_at DESC)`, `idx_audit_logs_actor_action` on `(actor_id, action, created_at DESC)`.

19. **`settings`**
    - `key TEXT PRIMARY KEY`
    - `value JSONB NOT NULL`
    - `description TEXT`
    - `updated_by UUID REFERENCES users(id)`
    - `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
    - Default keys: `llm.provider` (`"gemini"` | `"claude"` | `"disabled"`), `llm.gemini_model` (`"gemini-4-hydrogen"`), `llm.claude_model`, `phone.default_region` (`"IN"`), `upload.max_mb` (`50`), `retention.uploads_days` (`365`), `retention.exports_days` (`30`), `dedupe.name_similarity_threshold` (`0.86`), `dedupe.address_similarity_threshold` (`0.82`).

20. **`llm_value_cache`** *(Cost-control persistent cache)*
    - `cache_key CHAR(64) PRIMARY KEY` (SHA-256 of `task_type + "|" + provider + "|" + normalized_input`)
    - `task_type TEXT NOT NULL` (`ADDRESS_SPLIT | CATEGORY_CLASSIFY | NAME_PHONE_SPLIT`)
    - `provider TEXT NOT NULL`
    - `response_json JSONB NOT NULL`
    - `hit_count INT NOT NULL DEFAULT 1`
    - `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
    - `last_hit_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

---

## 4. REST API Contract

**Base Prefix:** `/api/v1` (configured on frontend via `VITE_API_BASE_URL`)  
**Standard Error Envelope:**
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable explanation",
    "details": [{ "path": "email", "message": "Invalid email" }],
    "requestId": "req_..."
  }
}
```

### 4.1 Auth Module (`/api/v1/auth`)

| Method & Path | Permission | Request Shape | Response Shape (`200/201`) |
|---|---|---|---|
| `POST /auth/login` | Public (Rate-limited) | `{ email: string, password: string }` | `{ user: UserDTO }` + sets `httpOnly` session & refresh cookies |
| `POST /auth/refresh` | Refresh Cookie | Cookie `structiq_refresh` | `{ user: UserDTO }` + rotates session & refresh cookies |
| `POST /auth/logout` | Authenticated | Cookie `structiq_session` | `{ success: true }` + clears cookies & revokes session |
| `GET /auth/me` | Authenticated | — | `{ user: UserDTO, permissions: Permission[] }` |
| `POST /auth/change-password` | Authenticated | `{ currentPassword: string, newPassword: string }` | `{ success: true }` |

### 4.2 Users Module (`/api/v1/users`)

| Method & Path | Permission | Request Shape | Response Shape |
|---|---|---|---|
| `GET /users` | `manage_users` | Query: `page, pageSize, search, role, isActive` | `{ items: UserDTO[], total: number }` |
| `POST /users` | `manage_users` | `{ email, fullName, password, role }` *(Admin cannot assign `SUPER_ADMIN`)* | `201 { user: UserDTO }` |
| `PATCH /users/:id` | `manage_users` | `{ fullName?, role?, isActive?, unlockAccount? }` | `{ user: UserDTO }` |
| `POST /users/:id/reset-password` | `manage_users` | `{ newPassword }` | `{ success: true }` |

### 4.3 Uploads Module (`/api/v1/uploads`)

| Method & Path | Permission | Request Shape | Response Shape |
|---|---|---|---|
| `POST /uploads` | `upload` (Strict Rate-limit) | `multipart/form-data`: `file`, `overrideDuplicate?: boolean` | `201 { upload: UploadDTO, sheets: SheetPreviewDTO[] }` or `409 DUPLICATE_FILE` with `existingUploadId` |
| `GET /uploads` | `view` | Query: `page, pageSize, status, search` | `{ items: UploadDTO[], total: number }` |
| `GET /uploads/:id` | `view` | Param: `id` | `{ upload: UploadDTO, sheets: SheetPreviewDTO[], jobs: JobDTO[] }` |
| `GET /uploads/:id/sheets/:sheetId/preview` | `view` | Query: `limit=50` | `{ headers: HeaderInfo[], rows: Record<string, unknown>[] }` |
| `POST /uploads/:id/sheets/:sheetId/select` | `process` | `{ selectedColumns: string[] }` | `{ sheet: SheetPreviewDTO }` |
| `DELETE /uploads/:id` | `delete` | Query: `permanent?: boolean` (`permanent=true` requires `SUPER_ADMIN`) | `{ success: true }` |

### 4.4 Mapping & Processing Module (`/api/v1/processing` & `/api/v1/templates`)

| Method & Path | Permission | Request Shape | Response Shape |
|---|---|---|---|
| `POST /uploads/:id/sheets/:sheetId/detect-mapping` | `process` | `{ useAi?: boolean }` | `{ mappings: ColumnMappingDTO[], suggestedTemplate?: MappingTemplateDTO }` |
| `PUT /uploads/:id/sheets/:sheetId/mapping` | `process` | `{ mappings: [{ sourceColumn, sourceIndex, targetField, customFieldKey? }], saveAsTemplateName?: string }` | `{ mappings: ColumnMappingDTO[], template?: MappingTemplateDTO }` |
| `POST /uploads/:id/sheets/:sheetId/start` | `process` | `{ checkDuplicatesAgainstMaster?: boolean, runCategorisation?: boolean }` | `202 { job: JobDTO }` |
| `GET /templates` | `view` | Query: `search` | `{ items: MappingTemplateDTO[] }` |
| `POST /templates` | `process` | `{ name, description?, mappings }` | `201 { template: MappingTemplateDTO }` |
| `DELETE /templates/:id` | `process` | Param: `id` | `{ success: true }` |

### 4.5 Jobs Module (`/api/v1/jobs`)

| Method & Path | Permission | Request Shape | Response Shape |
|---|---|---|---|
| `GET /jobs` | `view` | Query: `uploadId?, status?, page, pageSize` | `{ items: JobDTO[], total: number }` |
| `GET /jobs/:id` | `view` | Param: `id` | `{ job: JobDTO, chunksSummary: ChunkSummary }` |
| `GET /jobs/:id/stream` | `view` | SSE `Accept: text/event-stream` | Live `progress`, `status`, `completed` events |
| `POST /jobs/:id/cancel` | `process` | Param: `id` | `{ job: JobDTO }` |
| `POST /jobs/:id/retry` | `process` | Param: `id` (retries failed/dead-letter chunks) | `{ job: JobDTO }` |

### 4.6 Records & Review Module (`/api/v1/records`)

| Method & Path | Permission | Request Shape | Response Shape |
|---|---|---|---|
| `GET /records` | `view` | Query: `uploadId?, status?, search?, city?, district?, state?, pinCode?, phone?, categoryType?, categoryValue?, hasIssues?, hasInferred?, sortBy?, sortDir?, page, pageSize` | `{ items: CleanRecordDTO[], total: number, stats: StatusCounts }` |
| `GET /records/stats` | `view` | Query: `uploadId?` | `{ processed, verified, needsReview, invalid, potentialDuplicates, approved, rejected, total }` |
| `GET /records/:id` | `view` | Param: `id` | `{ record: CleanRecordDTO, rawRecord: RawRecordDTO, categories: CategoryTag[], history: RecordHistoryDTO[] }` |
| `PATCH /records/:id` | `edit` | `{ fullName?, street?, area?, city?, district?, state?, pinCode?, phoneRaw?, otherFields?, customCategories? }` | `{ record: CleanRecordDTO }` |
| `POST /records/bulk-edit` | `edit` | `{ recordIds: string[], patch: { city?, district?, state?, pinCode?, addCategory? } }` | `{ updatedCount: number }` |
| `POST /records/approve` | `approve` | `{ recordIds: string[], decision: 'APPROVED' | 'REJECTED', reason?: string }` | `{ updatedCount: number }` |
| `DELETE /records/:id` | `delete` | Query: `permanent?: boolean` (`SUPER_ADMIN` only for permanent) | `{ success: true }` |

### 4.7 Categorisation Module (`/api/v1/categories`)

| Method & Path | Permission | Request Shape | Response Shape |
|---|---|---|---|
| `GET /categories/rules` | `view` | Query: `categoryType?, isActive?` | `{ items: CategoryRuleDTO[] }` |
| `POST /categories/rules` | `process` | `{ name, priority, categoryType, categoryValue, parentRuleId?, conditions, isActive }` | `201 { rule: CategoryRuleDTO }` |
| `PATCH /categories/rules/:id` | `process` | Partial rule body | `{ rule: CategoryRuleDTO }` |
| `DELETE /categories/rules/:id` | `delete` | Param: `id` | `{ success: true }` |
| `POST /categories/recalculate` | `process` | `{ uploadId?: string }` | `202 { job: JobDTO }` |
| `GET /categories/tree` | `view` | Query: `uploadId?, status?` | `{ tree: HierarchyNode[] }` (`State > District > City > Street` + counts) |

### 4.8 Duplicates Module (`/api/v1/duplicates`)

| Method & Path | Permission | Request Shape | Response Shape |
|---|---|---|---|
| `GET /duplicates` | `view` | Query: `uploadId?, status?, matchType?, minConfidence?, page, pageSize` | `{ items: DuplicateGroupDTO[], total: number }` |
| `GET /duplicates/:groupId` | `view` | Param: `groupId` | `{ group: DuplicateGroupDTO, members: DuplicateMemberDetail[] }` |
| `POST /duplicates/:groupId/merge` | `approve` | `{ survivingRecordId: string, fieldSelections: Record<string, string> }` *(maps field -> chosen source record ID)* | `{ survivingRecord: CleanRecordDTO, group: DuplicateGroupDTO }` |
| `POST /duplicates/:groupId/dismiss` | `approve` | `{ reason?: string }` | `{ group: DuplicateGroupDTO }` |
| `POST /duplicates/:groupId/revert` | `approve` | `{ reason?: string }` | `{ restoredRecords: CleanRecordDTO[], group: DuplicateGroupDTO }` |

### 4.9 Exports Module (`/api/v1/exports`)

| Method & Path | Permission | Request Shape | Response Shape |
|---|---|---|---|
| `POST /exports` | `export` | `{ format: 'XLSX' | 'CSV', filters, columnOrder: string[], splitBy: 'NONE' | 'CITY' | 'DISTRICT' | 'STATE' | 'CATEGORY', includeOriginalSheet: boolean }` | `202 { exportRecord: ExportDTO, job?: JobDTO }` |
| `GET /exports` | `view` | Query: `page, pageSize` | `{ items: ExportDTO[], total: number }` |
| `GET /exports/:id/download` | `export` | Param: `id` | Binary stream (`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` or `text/csv`) |

### 4.10 Audit & Settings & Sample Data (`/api/v1/audit`, `/api/v1/settings`, `/api/v1/samples`)

| Method & Path | Permission | Request Shape | Response Shape |
|---|---|---|---|
| `GET /audit` | `manage_users` or `manage_settings` | Query: `actorId?, action?, resourceType?, from?, to?, page, pageSize` | `{ items: AuditLogDTO[], total: number }` |
| `GET /settings` | `manage_settings` | — | `{ settings: WorkspaceSettingsDTO }` |
| `PATCH /settings` | `manage_settings` | Partial validated settings object | `{ settings: WorkspaceSettingsDTO }` |
| `POST /settings/retention/purge` | `delete` (`SUPER_ADMIN`) | `{ dryRun: boolean }` | `{ dryRun, purgedUploads, purgedRecords, purgedExports }` |
| `GET /samples/messy-csv` | `upload` | — | Streamed generated messy sample CSV (no DB seeding!) |

---

## 5. Processing Pipeline Workflow (Stage by Stage)

```mermaid
flowchart LR
    S1["1. Parse\n(Stream + Hash)"] --> S2["2. Map\n(Rules + 30-row AI + Template)"]
    S2 --> S3["3. Extract\n(Deterministic + Cached Batch AI)"]
    S3 --> S4["4. Clean\n(libphonenumber-js + NFC + PIN)"]
    S4 --> S5["5. Validate\n(Issue Codes + INFERRED Flag)"]
    S5 --> S6["6. Categorise\n(Priority Rules + Hierarchy)"]
    S6 --> S7["7. Dedupe\n(Blocking + Jaro-Winkler)"]
    S7 --> S8["8. Review\n(Virtual Grid + Merge UI)"]
    S8 --> S9["9. Approve\n(Master Store + pg_trgm)"]
    S9 --> S10["10. Export\n(ExcelJS + Formula Guard)"]
```

### Stage Details

1. **Parse (`uploads` + `processing`)**
   - Validate extension, MIME, magic bytes, zip decompression ratio, and reject `.xlsm`/macros.
   - Compute SHA-256 of upload stream; store untouched file via `StorageAdapter`.
   - For CSV: detect BOM/encoding (`UTF-16LE`, `UTF-16BE`, `UTF-8`, fallback `Windows-1252` via `iconv-lite`) while preserving Tamil/Indic UTF-8/UTF-16 characters; stream with `csv-parse`.
   - For XLSX/XLS: parse workbook with SheetJS (`xlsx`) enforcing max sheet/row/column caps; store sheet headers & first 50 rows in `upload_sheets`.
   - When job starts, stream all rows into `raw_records` in batches of 1,000 rows with `row_fingerprint`. `raw_records` is **strictly immutable**.

2. **Map (`processing`)**
   - Check `mapping_templates` by `header_signature` first.
   - Run deterministic header & sample-value profiler (regex matches for 10-digit Indian phones, 6-digit PINs, address keywords like `road/st/nagar/pin/taluk/dist`).
   - If any columns remain low-confidence (`< 0.75`), send **only column headers + up to 30 anonymized/sampled rows** to `LLMProvider.detectColumnMappings()`. Validate JSON response with Zod.
   - Combine rule confidence and AI confidence; user reviews/overrides in UI and optionally saves a `mapping_template`.

3. **Extract (`processing`)**
   - For each 1,000-row chunk:
     - **Combined Name+Phone cells** (e.g., `"Ramesh Kumar - 9876543210 / 9123456789"`): extract phone substrings deterministically via regex, remaining string becomes `full_name` (`EXTRACTED`).
     - **Multi-phone cells** (e.g., `"9876543210, 044-24351234"`): split on `/[,;|\/]+/`, parse each via `libphonenumber-js`, store first valid mobile as primary and remainder in `secondary_phones`.
     - **Combined Address cells** (e.g., `"12, Gandhi Rd, Anna Nagar, Madurai 625020 TN"`): deterministic parser extracts 6-digit PIN (`\b[1-9]\d{5}\b`), known states/districts/cities dictionary, and comma-delimited street/area tokens.
     - **Ambiguous Address / Custom Field Queue**: Collect only unique strings within the chunk where deterministic extraction left low confidence (`< 0.70`) or unstructured tokens. Check `llm_value_cache` by SHA-256 hash. Only cache-misses are sent in batches of 25–50 unique strings to `LLMProvider.extractBatch()`.

4. **Clean (`processing`)**
   - Unicode `NFC` normalization; collapse excess whitespace; remove control characters.
   - Case normalization (Title Case for ASCII Latin words while preserving acronyms and never mangling Tamil/Indic script codepoints).
   - Phone cleaning (`libphonenumber-js`, default region from `settings` = `IN`): strip spaces/dashes/leading `0`/`+91`, format `phone_e164` (`+919876543210`) and `phone_display` (`+91 98765 43210`). Tag `provenance.phone_e164 = 'STANDARDISED'`.
   - PIN prefix lookup: if `pin_code` is valid 6-digit and `state` or `district` is empty, populate from local PIN directory and set `provenance.state = 'INFERRED'`, `has_inferred_fields = true`.

5. **Validate (`processing`)**
   - Run deterministic validation rules producing structured `issues`:
     - `MISSING_NAME` (WARN/ERROR)
     - `MISSING_PHONE` (WARN)
     - `INVALID_PHONE_FORMAT` (ERROR — e.g., non-`[6-9]` start for 10-digit IN mobile or failed `libphonenumber-js` check)
     - `INVALID_PIN_CODE` (ERROR — not 6 digits or outside valid postal range)
     - `INCOMPLETE_ADDRESS` (WARN — missing both street/area and city/district)
     - `INFERRED_VALUE_REQUIRES_REVIEW` (INFO — any field with `provenance = 'INFERRED'`)
   - Assign initial `status`:
     - Any `ERROR` issue -> `INVALID`
     - `has_inferred_fields === true` or `overall_confidence < 0.80` or `WARN` issues -> `NEEDS_REVIEW`
     - Clean & high confidence -> `PROCESSED` (or `VERIFIED` when rule confidence >= 0.95 and zero issues).

6. **Categorise (`categorisation`)**
   - Evaluate active `category_rules` ordered by `priority ASC`.
   - Build hierarchical location tags: `State > District > City > Street` into `record_categories`.
   - Assign business/customer categories via rules first; optional batched unique-value LLM classification for uncategorised business text (cached in `llm_value_cache`).

7. **Dedupe (`duplicates`)**
   - Runs per-chunk / post-chunk across the upload (and optionally against existing `APPROVED` records) using **blocking keys** to avoid $O(n^2)$:
     - **Block A**: exact `phone_e164`
     - **Block B**: exact `pin_code` + first 3 chars of `normalized_name`
     - **Block C**: exact `city` + phonetic key of `normalized_name`
   - Within each small candidate block, compute:
     - Exact `row_fingerprint` match (`score = 1.000`, `EXACT_FINGERPRINT`)
     - Same `phone_e164` + different name (`NAME_JW < 0.85` -> `SAME_PHONE_DIFF_NAME`, `score = 0.880`)
     - Weighted similarity (`0.55 * JaroWinkler(name) + 0.45 * LevenshteinSim(street+area)`) above configurable threshold -> `FUZZY_NAME_ADDRESS`.
   - Group linked pairs using Union-Find into `duplicate_groups` + `duplicate_members`, mark records `POTENTIAL_DUPLICATE`. **Never auto-merge.**

8. **Review & 9. Approve (`records` + `duplicates`)**
   - Reviewers use virtualised tables, keyboard shortcuts (`J/K` move, `E` edit, `A` approve, `X` reject), bulk edit, and side-by-side duplicate merge UI.
   - Approving updates `status = 'APPROVED'`, writes `record_history`, making records searchable in the persistent PostgreSQL store.

10. **Export (`exports`)**
    - ExcelJS streaming workbook writer (`WorkbookWriter`) for low memory footprint at 100k+ rows.
    - Neutralize Excel formula injection on every string cell starting with `=`, `+`, `-`, `@`, `\t`, or `\r` by prefixing `'`.
    - Generates: Master Sheet (custom column order, frozen header, auto-filters, styled headers), Split Worksheets (by City/District/Category), `Summary` sheet, `Processing Report` sheet (counts, issue breakdown, provenance breakdown), and `Original Data` sheet (sourced from `raw_records`). Also supports streaming CSV export.

### 5.1 AI + Rules Combination & Cost Control at 100,000 Rows

- **Rules First, AI Second:** Deterministic parsers, regexes, `libphonenumber-js`, and PIN/city dictionaries always run first.
- **Combined Confidence Formula:**
  - When Rule succeeds cleanly: `confidence = ruleConfidence` (no AI call).
  - When AI resolves an ambiguous cell: `combinedConfidence = min(0.95, 0.40 * ruleSignal + 0.60 * aiConfidence)`, validated by Zod (`z.object(...)`); if Zod fails or API errors/times out, fall back gracefully to deterministic output and flag `NEEDS_REVIEW`.
- **Cost Control at 100k Rows:**
  1. **Schema Mapping:** 1 LLM call per sheet total (~30 sampled rows + headers).
  2. **Value Deduplication + Persistent Cache:** Before calling the LLM for ambiguous addresses/categories, deduplicate identical strings across the 1,000-row chunk and query `llm_value_cache`. At 100k rows with repeated city/area/category text, cache hit rates typically exceed 70–90%.
  3. **Batching:** Up to 35 unique unresolved values per LLM request using structured `responseSchema` JSON output.
  4. **Hard Budget Guard:** Configurable `maxLlmCallsPerJob` / circuit breaker so an unusually noisy file never causes runaway token spend—excess ambiguous rows fall back to `NEEDS_REVIEW` with issue code `AI_BUDGET_SKIPPED_REVIEW_REQUIRED`.
  5. **Gemini SDK Pattern:** Uses `@google/genai` (`new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { headers: { 'User-Agent': 'aistudio-build' } } })`) with `gemini-4-hydrogen` and `responseSchema` (`Type`).

---

## 6. Background Job Queue Design (Postgres-Backed, No Redis)

### 6.1 Worker Abstraction
```ts
export interface JobWorkerInterface {
  start(): Promise<void>;
  stop(): Promise<void>;
  enqueueUploadProcessing(params: { jobId: string; totalRows: number; chunkSize?: number }): Promise<void>;
  enqueueExport(params: { jobId: string }): Promise<void>;
}
```
Initially `PostgresJobWorker` runs inside the Express server process on an internal polling loop (`1000ms` idle poll, immediate wake-up on local enqueue). Because all state lives in `jobs` and `job_chunks`, the worker can later be extracted into a separate worker container with zero API changes.

### 6.2 Chunking & Claiming (`FOR UPDATE SKIP LOCKED`)
- Jobs are partitioned into `job_chunks` of **1,000 rows** each (`row_start` to `row_end`).
- Workers claim one chunk atomically:
  ```sql
  WITH next_chunk AS (
    SELECT c.id
    FROM job_chunks c
    JOIN jobs j ON j.id = c.job_id
    WHERE c.status IN ('PENDING', 'RETRY_SCHEDULED')
      AND c.next_retry_at <= NOW()
      AND j.cancel_requested = false
      AND j.status IN ('QUEUED', 'RUNNING')
    ORDER BY j.created_at ASC, c.chunk_index ASC
    FOR UPDATE OF c SKIP LOCKED
    LIMIT 1
  )
  UPDATE job_chunks
  SET status = 'RUNNING',
      locked_by = $1,
      locked_at = NOW(),
      heartbeat_at = NOW(),
      attempt_count = attempt_count + 1
  FROM next_chunk
  WHERE job_chunks.id = next_chunk.id
  RETURNING job_chunks.*;
  ```
- During chunk processing, the worker updates `heartbeat_at` every 15 seconds.

### 6.3 Retries, Dead-Letter, Cancellation & Crash Recovery
- **Exponential Backoff:** On transient failure (e.g., DB timeout, LLM 429/503), if `attempt_count < max_attempts` (default `5`), transition chunk to `RETRY_SCHEDULED` with:
  `next_retry_at = NOW() + ((2 ^ attempt_count) * 5 seconds + random(0..3s) jitter)`.
- **Dead-Letter State:** If `attempt_count >= max_attempts` or error is non-retryable, mark chunk `DEAD_LETTER`. When all chunks are finished and `>= 1` chunk is `DEAD_LETTER`, job enters `FAILED_DEAD_LETTER`. Admins/Data Processors can inspect `last_error_message` and trigger `POST /jobs/:id/retry` to re-queue dead-letter chunks.
- **Resume After Server Restart:** A stale-lock reaper runs every 30 seconds (and on server boot). Any `RUNNING` chunk whose `heartbeat_at < NOW() - INTERVAL '90 seconds'` is reset to `RETRY_SCHEDULED` (if attempts remain) or `DEAD_LETTER`, allowing seamless resumption after process crash/restart without reprocessing completed chunks.
- **Cancellation:** `POST /jobs/:id/cancel` sets `cancel_requested = true`. Workers check `cancel_requested` before claiming and after chunk completion, transitioning remaining `PENDING` chunks to `CANCELLED` and marking the job `CANCELLED`.

---

## 7. Security Model & Threat List

### 7.1 Authentication, Sessions & RBAC
- Passwords hashed with **Argon2id** (`argon2` library); password policy requires minimum 12 chars with upper, lower, digit, and symbol.
- `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` bootstrap the initial `SUPER_ADMIN` idempotently on first boot (if no `SUPER_ADMIN` exists). No hardcoded credentials exist in source.
- Login rate limit: `express-rate-limit` (e.g., 10 requests / 15 min per IP) + account lockout after 5 consecutive failed logins (`locked_until = NOW() + 15 minutes`).
- Cookies: `httpOnly: true`, `secure: NODE_ENV === 'production'`, `sameSite: 'lax'`, signed/opaque random 256-bit tokens hashed in `sessions`. Refresh tokens rotate on use; reuse of an already-rotated refresh token invalidates the entire `token_family_id`.
- Every route applies `requireAuth` + `requirePermission('...')` middleware on the server; UI hiding is strictly secondary.

### 7.2 Threat Model for File Uploads & PII

| Threat | Mitigation |
|---|---|
| **Malicious File / Executable Spoofing** | Validate extension (`.xlsx`, `.xls`, `.csv` only), MIME type, **and magic bytes** (`PK\x03\x04` for XLSX, OLE2 `D0 CF 11 E0` for XLS, valid text/BOM check for CSV). Reject `.xlsm` (macro-enabled) and `.xlsb` unconditionally. |
| **Zip Bombs / Billion Laughs XML** | Before full parsing of `.xlsx` (ZIP container), inspect ZIP central directory / entry uncompressed sizes: reject if uncompressed size > 250 MB, compression ratio > 50:1, or file count > 500 entries. Enforce max 500 columns and max 250,000 rows per upload (configurable). |
| **Excel Formula / CSV Injection** | On every XLSX and CSV export cell, check if trimmed string begins with `=`, `+`, `-`, `@`, `\t`, or `\r`; prepend `'` (single quote) to neutralize formula execution in Excel/LibreOffice/Sheets. |
| **SQL Injection** | 100% parameterized queries via `pg` (`$1, $2...`). Dynamic sort/filter column names are strictly whitelisted via Zod enums mapped to server-side column constants. |
| **PII Leakage in Logs & Errors** | Structured logger redacts `password`, `token`, `cookie`, `raw_data`, `full_name`, `phone`, `address`. `audit_logs` records record UUIDs and changed field names—never raw PII values. |
| **Cross-Site Scripting / Clickjacking / CSRF** | `helmet()` CSP & frame headers (configured for AI Studio preview iframe compatibility via `frame-ancestors`), strict `CORS` allowlist, `SameSite` cookies + custom header/origin verification on state-changing routes. |
| **Unauthorized Data Destruction** | `raw_records` is immutable. Soft-delete (`deleted_at`) is reversible; permanent purge requires `SUPER_ADMIN` role + explicit retention job audit entry. |

### 7.3 Backup & Restore Procedure (Operational Standard)
1. **Database Backups:** Automated daily `pg_dump --format=custom --no-owner` encrypted at rest in a separate bucket/vault, plus Point-In-Time Recovery (PITR) WAL archiving on managed Postgres.
2. **Object Storage Backups:** GCS Object Versioning enabled on `GCS_BUCKET` with lifecycle retention matching workspace policy.
3. **Restore Verification:** Monthly restore drill into staging DB (`pg_restore --clean --if-exists`) followed by integrity check comparing `uploads.file_sha256` against restored `raw_records` counts.

---

## 8. Implementation Roadmap (Phases 2–9) & Acceptance Tests

| Phase | Scope & Deliverables | End-to-End Acceptance Tests |
|---|---|---|
| **Phase 2: Database + Auth** | `pg` pool, migration runner, schema SQL migrations (`001_init.sql`..), Super Admin seeding from secrets, Argon2id auth, session/refresh cookies, login rate limiting & lockout, RBAC middleware, Login UI & persistent Enterprise App Shell (light/dark, sidebar, topbar). | 1. Fresh DB migrates cleanly and seeds `SUPER_ADMIN`.<br>2. Unauthenticated request returns `401`; `READ_ONLY` calling `POST /uploads` returns `403`.<br>3. 5 bad passwords lock account and return `423`/`429`.<br>4. Refresh rotates cookie and invalidates replay. |
| **Phase 3: Dashboard + Upload** | `StorageAdapter` (GCS + dev local disk), magic-byte/MIME/zip-bomb guards, SheetJS + streaming `csv-parse` encoding detector (UTF-8/16/Win-1252 preserving Tamil), 50-row preview, sheet & column selection, duplicate file hash check + override, Upload History, "Download sample CSV" generator, Pipeline Dashboard UI. | 1. Upload messy multi-sheet XLSX & Tamil-script CSV -> preview shows 50 rows accurately.<br>2. Uploading `.xlsm` or renamed `.exe` is rejected with clear error.<br>3. Re-uploading same file blocks with `409` and allows explicit override.<br>4. Original file SHA-256 matches file in storage. |
| **Phase 4: Extraction & Processing Engine** | `PostgresJobQueue` (1,000-row chunks, retries, stale-lock recovery, cancel, dead-letter), `LLMProvider` (Gemini `@google/genai` + Claude + Zod validation + `llm_value_cache`), rule-first schema mapper, template CRUD, combined address/phone/name extraction, provenance tagging (`EXTRACTED`/`STANDARDISED`/`INFERRED`), live SSE/progress bar. | 1. Auto-detect columns with per-column confidence & save mapping template.<br>2. Combined `"Name - 9876543210"` and combined Tamil Nadu addresses split accurately with provenance tags.<br>3. Simulated server restart mid-job resumes remaining chunks cleanly.<br>4. LLM failure falls back to rules without crashing job. |
| **Phase 5: Categorisation + Cleaning** | `libphonenumber-js` E.164 & display formatting (IN rules), 6-digit PIN validation & offline prefix inference (`INFERRED` + auto-flag), issue code generator with plain-language explanations, priority-based `category_rules` engine, `State > District > City > Street` hierarchy tree UI. | 1. Invalid phone (e.g., `12345`) & bad PIN flagged with clear codes & explanations.<br>2. `+91-98765 43210` & `09876543210` normalize to `+919876543210`.<br>3. Rules group Madurai / Tirunelveli records into hierarchical tree.<br>4. Every `INFERRED` field forces `NEEDS_REVIEW`. |
| **Phase 6: Duplicates + Review Dashboard** | Blocking-key duplicate engine + Jaro-Winkler/Levenshtein + phonetic keys, side-by-side compare & field-level reversible merge UI, virtualised 100k-row Review Table (server-side pagination/sort/filter, density toggle, inline & bulk edit, single/bulk approve/reject, keyboard shortcuts). | 1. 10,000-row upload dedupes in <5s via blocking keys (no $O(n^2)$).<br>2. Merging two records creates `record_history`; reverting restores both records.<br>3. Inline edit, bulk edit, and keyboard-driven approve/reject update DB & stats. |
| **Phase 7: Excel & CSV Export** | Streaming ExcelJS writer, custom column ordering, split worksheets by city/district/category, `Summary`, `Processing Report`, and `Original Data` sheets, formula-injection neutralization, CSV export, background export jobs + Exports History download UI. | 1. Exported XLSX opens cleanly with styled frozen headers, auto-filters, Summary, Processing Report, and Original Data sheets.<br>2. Cell `=CMD|'/C calc'` is exported neutralized as `'=CMD...`.<br>3. Large export runs via background job and downloads from history. |
| **Phase 8: User Management + Audit + Search + Retention** | User CRUD UI (Super Admin vs Admin boundary), Global `pg_trgm` fuzzy search across approved records, Record Version History drawer, Audit Log viewer with filters, Settings console, Retention & Super Admin permanent purge. | 1. Admin cannot create/modify Super Admin (`403`).<br>2. Global search finds fuzzy-matched customer names/streets across approved records.<br>3. Audit log captures logins, edits, merges, exports, settings without PII.<br>4. Super Admin purge deletes expired soft-deleted records. |
| **Phase 9: Testing, Security Review & Deployment** | Automated integration/unit test suite (auth, RBAC, parser guards, cleaning, dedupe, formula injection), 50k+ row benchmark test, security audit verification, production build (`npm run build` + `node server.ts`), complete `README.md`. | 1. All automated tests pass.<br>2. 50k+ row end-to-end upload -> process -> review -> export completes within memory/time budgets.<br>3. Production build & health checks verified. |

---

## 9. Secrets & Environment Variables Reference

Configure these in the **Settings > Secrets** panel (or `.env` in local development). Never commit real values to source control.

| Variable | Required | Scope | Purpose | Example Format |
|---|---|---|---|---|
| `DATABASE_URL` | **Yes** | Server | PostgreSQL connection string (`pg_trgm` enabled) | `postgresql://user:pass@host:5432/structiq?sslmode=require` |
| `SESSION_SECRET` | **Yes** | Server | HMAC/cookie signing secret (min 32 random chars) | `openssl rand -hex 32` |
| `REFRESH_SECRET` | **Yes** | Server | Refresh cookie signing secret (min 32 random chars) | `openssl rand -hex 32` |
| `SEED_ADMIN_EMAIL` | **Yes** (initial boot) | Server | Email for bootstrap Super Admin account | `admin@structiq.example` |
| `SEED_ADMIN_PASSWORD` | **Yes** (initial boot) | Server | Strong password for bootstrap Super Admin | `Str0ng!Admin#Pass2026` |
| `GEMINI_API_KEY` | Recommended | Server | Google Gemini API key for `@google/genai` (`gemini-4-hydrogen`) | `AIza...` |
| `ANTHROPIC_API_KEY` | Optional | Server | Anthropic API key if selecting Claude in Settings | `sk-ant-...` |
| `STORAGE_DRIVER` | Optional | Server | `gcs` (production) or `local` (dev-only fallback) | `gcs` |
| `GCS_BUCKET` | Prod Yes | Server | Google Cloud Storage bucket for raw uploads & exports | `structiq-prod-storage` |
| `GCS_SERVICE_ACCOUNT_JSON` | Prod Yes | Server | Service account JSON string for GCS access | `{"type":"service_account",...}` |
| `MAX_UPLOAD_MB` | Optional | Server | Maximum allowed upload size in megabytes | `50` |
| `CORS_ORIGIN` | Optional | Server | Comma-separated allowed frontend origins | `https://app.structiq.example` |
| `APP_URL` | Optional | Server | Public URL of the service | `https://app.structiq.example` |
| `VITE_API_BASE_URL` | Optional | Client | API base URL when frontend is deployed independently (empty = same origin) | `https://api.structiq.example` |
| `PORT` | Optional | Server | HTTP server port (defaults to `3000`) | `3000` |
| `NODE_ENV` | Optional | Server | Runtime environment (`development` \| `production`) | `production` |
