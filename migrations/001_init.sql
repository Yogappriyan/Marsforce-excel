-- StructIQ Initial PostgreSQL Schema (Migration 001)
-- Compatible with PostgreSQL 15+ (external DATABASE_URL) and PGlite 18 (local persisted)

CREATE EXTENSION IF NOT EXISTS pg_trgm;

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('SUPER_ADMIN', 'ADMIN', 'DATA_PROCESSOR', 'REVIEWER', 'READ_ONLY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE upload_status AS ENUM ('UPLOADED', 'PARSING_PREVIEW', 'READY_TO_MAP', 'MAPPED', 'PROCESSING', 'PROCESSED', 'FAILED', 'DELETED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE job_type AS ENUM ('INGEST_AND_PROCESS', 'REPROCESS_CATEGORISE', 'DETECT_DUPLICATES', 'EXPORT_DATASET', 'RETENTION_PURGE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE job_status AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'CANCEL_REQUESTED', 'CANCELLED', 'FAILED_DEAD_LETTER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE chunk_status AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'RETRY_SCHEDULED', 'DEAD_LETTER', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE record_status AS ENUM ('PROCESSED', 'VERIFIED', 'NEEDS_REVIEW', 'INVALID', 'POTENTIAL_DUPLICATE', 'APPROVED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE duplicate_status AS ENUM ('PENDING', 'MERGED', 'DISMISSED', 'REVERTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE export_format AS ENUM ('XLSX', 'CSV');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE export_status AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'EXPIRED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 1. RBAC Tables
CREATE TABLE IF NOT EXISTS roles (
  name user_role PRIMARY KEY,
  description TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS permissions (
  code TEXT PRIMARY KEY,
  description TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role user_role NOT NULL REFERENCES roles(name) ON DELETE CASCADE,
  permission TEXT NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role, permission)
);

-- 2. Users & Sessions
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role user_role NOT NULL DEFAULT 'READ_ONLY',
  is_active BOOLEAN NOT NULL DEFAULT true,
  failed_login_attempts INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  password_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_token_hash TEXT UNIQUE NOT NULL,
  refresh_token_hash TEXT UNIQUE NOT NULL,
  token_family_id UUID NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  refresh_expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_active ON sessions(user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- 3. Uploads, Sheets, Templates & Column Mappings
CREATE TABLE IF NOT EXISTS uploads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uploaded_by UUID NOT NULL REFERENCES users(id),
  original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_extension TEXT NOT NULL,
  file_size_bytes BIGINT NOT NULL,
  file_sha256 CHAR(64) NOT NULL,
  storage_driver TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  detected_encoding TEXT,
  is_duplicate_override BOOLEAN NOT NULL DEFAULT false,
  duplicate_of_upload_id UUID REFERENCES uploads(id) ON DELETE SET NULL,
  status upload_status NOT NULL DEFAULT 'UPLOADED',
  error_code TEXT,
  error_message TEXT,
  total_rows INT NOT NULL DEFAULT 0,
  deleted_at TIMESTAMPTZ,
  retention_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_uploads_sha256 ON uploads(file_sha256) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_uploads_created ON uploads(created_at DESC);

CREATE TABLE IF NOT EXISTS upload_sheets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id UUID NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  sheet_index INT NOT NULL,
  sheet_name TEXT NOT NULL,
  row_count INT NOT NULL,
  column_count INT NOT NULL,
  headers JSONB NOT NULL DEFAULT '[]',
  preview_rows JSONB NOT NULL DEFAULT '[]',
  is_selected BOOLEAN NOT NULL DEFAULT false,
  selected_columns JSONB NOT NULL DEFAULT '[]',
  UNIQUE (upload_id, sheet_index)
);

CREATE TABLE IF NOT EXISTS mapping_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  header_signature CHAR(64),
  mappings JSONB NOT NULL DEFAULT '[]',
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mapping_templates_sig ON mapping_templates(header_signature);

CREATE TABLE IF NOT EXISTS column_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id UUID NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  sheet_id UUID NOT NULL REFERENCES upload_sheets(id) ON DELETE CASCADE,
  source_column TEXT NOT NULL,
  source_index INT NOT NULL,
  target_field TEXT NOT NULL,
  custom_field_key TEXT,
  detection_source TEXT NOT NULL DEFAULT 'RULE',
  confidence NUMERIC(4,3) NOT NULL DEFAULT 1.000,
  template_id UUID REFERENCES mapping_templates(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sheet_id, source_index)
);

-- 4. Postgres-Backed Job Queue
CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type job_type NOT NULL,
  status job_status NOT NULL DEFAULT 'QUEUED',
  upload_id UUID REFERENCES uploads(id) ON DELETE CASCADE,
  sheet_id UUID REFERENCES upload_sheets(id) ON DELETE SET NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  payload JSONB NOT NULL DEFAULT '{}',
  total_records INT NOT NULL DEFAULT 0,
  processed_records INT NOT NULL DEFAULT 0,
  failed_records INT NOT NULL DEFAULT 0,
  total_chunks INT NOT NULL DEFAULT 0,
  completed_chunks INT NOT NULL DEFAULT 0,
  cancel_requested BOOLEAN NOT NULL DEFAULT false,
  error_summary TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_upload ON jobs(upload_id);

CREATE TABLE IF NOT EXISTS job_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  chunk_index INT NOT NULL,
  row_start INT NOT NULL,
  row_end INT NOT NULL,
  status chunk_status NOT NULL DEFAULT 'PENDING',
  attempt_count INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_by TEXT,
  locked_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_message TEXT,
  completed_at TIMESTAMPTZ,
  UNIQUE (job_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_job_chunks_claim ON job_chunks(status, next_retry_at) WHERE status IN ('PENDING', 'RETRY_SCHEDULED');
CREATE INDEX IF NOT EXISTS idx_job_chunks_stale ON job_chunks(locked_at, heartbeat_at) WHERE status = 'RUNNING';

-- 5. Immutable Raw Records & Structured Clean Records
CREATE TABLE IF NOT EXISTS raw_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id UUID NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  sheet_id UUID NOT NULL REFERENCES upload_sheets(id) ON DELETE CASCADE,
  row_number INT NOT NULL,
  row_fingerprint CHAR(64) NOT NULL,
  raw_data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sheet_id, row_number)
);

CREATE INDEX IF NOT EXISTS idx_raw_records_upload ON raw_records(upload_id, row_number);
CREATE INDEX IF NOT EXISTS idx_raw_records_fingerprint ON raw_records(row_fingerprint);

CREATE TABLE IF NOT EXISTS clean_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_record_id UUID UNIQUE NOT NULL REFERENCES raw_records(id) ON DELETE CASCADE,
  upload_id UUID NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  full_name TEXT,
  normalized_name TEXT,
  street TEXT,
  area TEXT,
  city TEXT,
  district TEXT,
  state TEXT,
  pin_code VARCHAR(6),
  phone_e164 VARCHAR(20),
  phone_display VARCHAR(24),
  secondary_phones JSONB NOT NULL DEFAULT '[]',
  other_fields JSONB NOT NULL DEFAULT '{}',
  provenance JSONB NOT NULL DEFAULT '{}',
  field_confidence JSONB NOT NULL DEFAULT '{}',
  overall_confidence NUMERIC(4,3) NOT NULL DEFAULT 0.000,
  status record_status NOT NULL DEFAULT 'PROCESSED',
  has_inferred_fields BOOLEAN NOT NULL DEFAULT false,
  issues JSONB NOT NULL DEFAULT '[]',
  is_merged BOOLEAN NOT NULL DEFAULT false,
  merged_into_id UUID REFERENCES clean_records(id) ON DELETE SET NULL,
  approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clean_records_status ON clean_records(status, upload_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_clean_records_phone ON clean_records(phone_e164) WHERE deleted_at IS NULL AND phone_e164 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_clean_records_pin ON clean_records(pin_code) WHERE deleted_at IS NULL AND pin_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_clean_records_city_dist ON clean_records(city, district, state) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_clean_records_approved ON clean_records(approved_at DESC) WHERE status = 'APPROVED' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_clean_records_name_trgm ON clean_records USING GIN (full_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_clean_records_street_trgm ON clean_records USING GIN (street gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_clean_records_city_trgm ON clean_records USING GIN (city gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_clean_records_district_trgm ON clean_records USING GIN (district gin_trgm_ops);

-- 6. Categorisation Rules & Tags
CREATE TABLE IF NOT EXISTS category_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  priority INT NOT NULL DEFAULT 100,
  category_type TEXT NOT NULL,
  category_value TEXT NOT NULL,
  parent_rule_id UUID REFERENCES category_rules(id) ON DELETE SET NULL,
  conditions JSONB NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_category_rules_priority ON category_rules(priority ASC) WHERE is_active = true;

CREATE TABLE IF NOT EXISTS record_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clean_record_id UUID NOT NULL REFERENCES clean_records(id) ON DELETE CASCADE,
  category_type TEXT NOT NULL,
  category_value TEXT NOT NULL,
  hierarchy_path TEXT,
  rule_id UUID REFERENCES category_rules(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'RULE',
  confidence NUMERIC(4,3) NOT NULL DEFAULT 1.000,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (clean_record_id, category_type, category_value)
);

CREATE INDEX IF NOT EXISTS idx_record_categories_lookup ON record_categories(category_type, category_value, clean_record_id);
CREATE INDEX IF NOT EXISTS idx_record_categories_path ON record_categories(hierarchy_path);

-- 7. Duplicate Groups, Members & Record History
CREATE TABLE IF NOT EXISTS duplicate_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id UUID REFERENCES uploads(id) ON DELETE CASCADE,
  match_type TEXT NOT NULL,
  confidence NUMERIC(4,3) NOT NULL,
  status duplicate_status NOT NULL DEFAULT 'PENDING',
  surviving_record_id UUID REFERENCES clean_records(id) ON DELETE SET NULL,
  resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dup_groups_status ON duplicate_groups(status, upload_id);

CREATE TABLE IF NOT EXISTS duplicate_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES duplicate_groups(id) ON DELETE CASCADE,
  clean_record_id UUID NOT NULL REFERENCES clean_records(id) ON DELETE CASCADE,
  match_score NUMERIC(4,3) NOT NULL,
  match_reasons JSONB NOT NULL DEFAULT '[]',
  is_suggested_primary BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (group_id, clean_record_id)
);

CREATE INDEX IF NOT EXISTS idx_dup_members_record ON duplicate_members(clean_record_id);

CREATE TABLE IF NOT EXISTS record_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clean_record_id UUID NOT NULL REFERENCES clean_records(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  before_state JSONB,
  after_state JSONB NOT NULL,
  changed_fields TEXT[] NOT NULL DEFAULT '{}',
  duplicate_group_id UUID REFERENCES duplicate_groups(id) ON DELETE SET NULL,
  revert_of_history_id UUID REFERENCES record_history(id) ON DELETE SET NULL,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_record_history_record ON record_history(clean_record_id, created_at DESC);

-- 8. Exports, Audit Logs, Settings & LLM Value Cache
CREATE TABLE IF NOT EXISTS exports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  requested_by UUID NOT NULL REFERENCES users(id),
  format export_format NOT NULL,
  filename TEXT NOT NULL,
  filters JSONB NOT NULL DEFAULT '{}',
  column_order JSONB NOT NULL DEFAULT '[]',
  split_by TEXT NOT NULL DEFAULT 'NONE',
  include_original_sheet BOOLEAN NOT NULL DEFAULT true,
  status export_status NOT NULL DEFAULT 'QUEUED',
  row_count INT NOT NULL DEFAULT 0,
  file_size_bytes BIGINT,
  storage_driver TEXT,
  storage_key TEXT,
  error_message TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_exports_user_created ON exports(requested_by, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_role user_role,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  ip_address TEXT,
  user_agent TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_action ON audit_logs(actor_id, action, created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  description TEXT,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS llm_value_cache (
  cache_key CHAR(64) PRIMARY KEY,
  task_type TEXT NOT NULL,
  provider TEXT NOT NULL,
  response_json JSONB NOT NULL,
  hit_count INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_hit_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 9. Seed Roles, Permissions & Default Settings (no fake data records)
INSERT INTO roles (name, description) VALUES
  ('SUPER_ADMIN', 'Full system ownership including users, retention policies, and permanent purge.'),
  ('ADMIN', 'All data actions, settings, and user management excluding Super Admins.'),
  ('DATA_PROCESSOR', 'Upload datasets, configure mappings, process jobs, edit records, and export.'),
  ('REVIEWER', 'Review, edit, approve/reject records, and resolve duplicate groups.'),
  ('READ_ONLY', 'View and search structured records and history.')
ON CONFLICT (name) DO NOTHING;

INSERT INTO permissions (code, description) VALUES
  ('view', 'View dashboards, uploads, records, categories, duplicates, and search'),
  ('upload', 'Upload Excel/CSV files and download sample templates'),
  ('process', 'Configure mappings, rules, and run/cancel processing jobs'),
  ('edit', 'Inline edit and bulk edit clean records'),
  ('approve', 'Approve/reject records and merge/dismiss/revert duplicates'),
  ('export', 'Generate and download structured Excel/CSV exports'),
  ('manage_users', 'Create, edit, deactivate, and unlock user accounts'),
  ('manage_settings', 'Configure AI providers, regional rules, retention, and view audit logs'),
  ('delete', 'Soft-delete uploads/records (permanent purge restricted to Super Admin)')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role, permission) VALUES
  ('SUPER_ADMIN', 'view'), ('SUPER_ADMIN', 'upload'), ('SUPER_ADMIN', 'process'),
  ('SUPER_ADMIN', 'edit'), ('SUPER_ADMIN', 'approve'), ('SUPER_ADMIN', 'export'),
  ('SUPER_ADMIN', 'manage_users'), ('SUPER_ADMIN', 'manage_settings'), ('SUPER_ADMIN', 'delete'),

  ('ADMIN', 'view'), ('ADMIN', 'upload'), ('ADMIN', 'process'),
  ('ADMIN', 'edit'), ('ADMIN', 'approve'), ('ADMIN', 'export'),
  ('ADMIN', 'manage_users'), ('ADMIN', 'manage_settings'), ('ADMIN', 'delete'),

  ('DATA_PROCESSOR', 'view'), ('DATA_PROCESSOR', 'upload'), ('DATA_PROCESSOR', 'process'),
  ('DATA_PROCESSOR', 'edit'), ('DATA_PROCESSOR', 'export'),

  ('REVIEWER', 'view'), ('REVIEWER', 'edit'), ('REVIEWER', 'approve'),

  ('READ_ONLY', 'view')
ON CONFLICT (role, permission) DO NOTHING;

INSERT INTO settings (key, value, description) VALUES
  ('llm.provider', '"gemini"', 'Active LLM provider: gemini, claude, or disabled'),
  ('llm.gemini_model', '"gemini-4-hydrogen"', 'Gemini model identifier'),
  ('llm.claude_model', '"claude-sonnet-4-5"', 'Claude model identifier'),
  ('phone.default_region', '"IN"', 'Default ISO 3166-1 alpha-2 country code for phone parsing'),
  ('upload.max_mb', '50', 'Maximum upload file size in MB'),
  ('retention.uploads_days', '365', 'Soft-deleted upload/record retention window in days'),
  ('retention.exports_days', '30', 'Generated export artifact retention window in days'),
  ('dedupe.name_similarity_threshold', '0.86', 'Jaro-Winkler threshold for fuzzy name matching'),
  ('dedupe.address_similarity_threshold', '0.80', 'Similarity threshold for fuzzy address matching')
ON CONFLICT (key) DO NOTHING;
