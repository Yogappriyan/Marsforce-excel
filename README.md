# StructIQ — Enterprise AI Data Structuring Platform

StructIQ is a standalone, production-grade AI data structuring platform built with **React + TypeScript + Tailwind CSS**, **Node.js + Express + TypeScript**, and **PostgreSQL (`pg_trgm`)**. It ingests messy multi-format Excel/CSV datasets (1,000–100,000+ rows), detects and maps columns, extracts & standardises addresses and phone numbers with per-field provenance, categorises records hierarchically, detects duplicates via blocking keys, supports human review and reversible merges, and exports styled multi-sheet Excel workbooks.

## Key Capabilities

- **Secure Ingestion:** Extension, MIME, and magic-byte validation; blocks macro-enabled `.xlsm` files and zip bombs; detects CSV encodings (`UTF-8`, `UTF-16LE/BE`, `Windows-1252`) preserving Tamil/Indic scripts; SHA-256 duplicate import detection with explicit override.
- **Data Understanding & Cleaning:** Deterministic-first rules + optional 30-row AI schema mapping (`GeminiProvider` via `@google/genai` or `ClaudeProvider`), combined cell splitting (`name_and_phone`, `address_combined`, `phone_multi`), `libphonenumber-js` E.164 standardization, 6-digit PIN validation, and strict provenance tagging (`EXTRACTED`, `STANDARDISED`, `INFERRED`).
- **Postgres-Backed Job Queue:** Chunked 1,000-row processing with `FOR UPDATE SKIP LOCKED`, live SSE progress, exponential backoff retries, stale-lock crash recovery, cancellation, and dead-letter retry.
- **Categorisation & Deduplication:** Priority rule engine, `State > District > City > Street` hierarchy, blocking-key Jaro-Winkler/Levenshtein/phonetic matching, side-by-side field merge, and full `record_history` merge reversal.
- **Review & Export:** Virtualised 100k+ row grid, keyboard shortcuts (`J`/`K`/`E`/`A`/`X`), inline/bulk editing, streaming ExcelJS writer with formula-injection neutralization (`= + - @`), Summary, Processing Report, and Original Data sheets.
- **RBAC & Governance:** `SUPER_ADMIN`, `ADMIN`, `DATA_PROCESSOR`, `REVIEWER`, `READ_ONLY` enforced server-side, bcrypt password hashing, httpOnly cookie sessions with refresh token rotation, login lockout, PII-redacted audit logs, and retention purge.

## Local Development & Secrets

1. Copy `.env.example` to `.env` and populate secrets:
   - `DATABASE_URL`: PostgreSQL 15+ connection string (`pg_trgm` enabled). If omitted in development, StructIQ persists PostgreSQL locally to `.data/pgdata` via embedded PGlite.
   - `SESSION_SECRET` / `REFRESH_SECRET`: 32+ hex character secrets.
   - `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`: Optional initial Super Admin seed. If omitted on an empty database, the web UI presents an interactive First-Run Super Admin Setup screen.
   - `GEMINI_API_KEY` / `ANTHROPIC_API_KEY`: Optional server-side AI provider keys.
   - `GCS_BUCKET` / `GCS_SERVICE_ACCOUNT_JSON`: Optional Google Cloud Storage credentials (`STORAGE_DRIVER=gcs`).

2. Install & run:
   ```bash
   npm install
   npm run dev
   ```
   The server runs Express + Vite middleware on port `3000`.

## Production Build & Deployment

```bash
npm run build
npm run start
```

### Independent Frontend Deployment
Build `src/` separately and set `VITE_API_BASE_URL=https://api.yourcompany.com` along with `CORS_ORIGIN=https://app.yourcompany.com` on the backend.

## Backup & Restore Procedure

1. **PostgreSQL:** Schedule daily encrypted `pg_dump --format=custom --no-owner "$DATABASE_URL"` backups alongside WAL Point-In-Time Recovery (PITR).
2. **Object Storage:** Enable Object Versioning on `GCS_BUCKET` aligned with `retention.uploads_days`.
3. **Restore Verification:** Restore to staging via `pg_restore --clean --if-exists` and verify `uploads.file_sha256` against stored raw objects and `raw_records` row counts.
