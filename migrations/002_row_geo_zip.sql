-- StructIQ Migration 002: Row Intelligence, Geographic Hierarchy & Multi-Workbook Export Support
-- Preserves all existing tables and stored records safely.

ALTER TYPE export_format ADD VALUE IF NOT EXISTS 'ZIP';

DO $$ BEGIN
  CREATE TYPE row_type AS ENUM (
    'COLUMN_HEADER',
    'CUSTOMER_RECORD',
    'SECTION_HEADING',
    'EMPTY_SEPARATOR',
    'SUBTOTAL_OR_REPORT_ROW',
    'INVALID_RECORD',
    'NEEDS_REVIEW'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 1. Extend upload_sheets with physical row & header row metadata
ALTER TABLE upload_sheets
  ADD COLUMN IF NOT EXISTS include_hidden_rows BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS header_row_number INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS physical_row_count INT NOT NULL DEFAULT 0;

-- 2. Extend clean_records with Consumer ID & Street-Level Geographic Hierarchy
ALTER TABLE clean_records
  ADD COLUMN IF NOT EXISTS consumer_id TEXT,
  ADD COLUMN IF NOT EXISTS distributor_id TEXT,
  ADD COLUMN IF NOT EXISTS sub_area TEXT,
  ADD COLUMN IF NOT EXISTS locality TEXT,
  ADD COLUMN IF NOT EXISTS street_group TEXT,
  ADD COLUMN IF NOT EXISTS group_type TEXT,
  ADD COLUMN IF NOT EXISTS section_heading_context TEXT,
  ADD COLUMN IF NOT EXISTS classification_source TEXT,
  ADD COLUMN IF NOT EXISTS classification_confidence NUMERIC(4,3) NOT NULL DEFAULT 0.000,
  ADD COLUMN IF NOT EXISTS geographic_review_status TEXT NOT NULL DEFAULT 'AUTO',
  ADD COLUMN IF NOT EXISTS geographic_conflict_reason TEXT,
  ADD COLUMN IF NOT EXISTS original_sheet_name TEXT,
  ADD COLUMN IF NOT EXISTS original_row_number INT,
  ADD COLUMN IF NOT EXISTS precision_loss_detected BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_clean_records_geo_tree
  ON clean_records(upload_id, area, street_group)
  WHERE deleted_at IS NULL AND is_merged = false;

CREATE INDEX IF NOT EXISTS idx_clean_records_geo_status
  ON clean_records(upload_id, geographic_review_status)
  WHERE deleted_at IS NULL AND is_merged = false;

CREATE INDEX IF NOT EXISTS idx_clean_records_consumer_id
  ON clean_records(consumer_id)
  WHERE deleted_at IS NULL AND consumer_id IS NOT NULL;

-- 3. Physical Source Rows Audit Table (100% physical row preservation & traceability)
CREATE TABLE IF NOT EXISTS source_rows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id UUID NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  sheet_id UUID NOT NULL REFERENCES upload_sheets(id) ON DELETE CASCADE,
  sheet_name TEXT NOT NULL,
  physical_row_number INT NOT NULL,
  row_type row_type NOT NULL,
  raw_cells JSONB NOT NULL DEFAULT '{}',
  display_cells JSONB NOT NULL DEFAULT '{}',
  format_meta JSONB NOT NULL DEFAULT '{}',
  active_section_heading TEXT,
  detected_area TEXT,
  detected_sub_area TEXT,
  detected_street TEXT,
  street_group TEXT,
  group_type TEXT,
  classification_source TEXT,
  classification_confidence NUMERIC(4,3) NOT NULL DEFAULT 0.000,
  validation_issues JSONB NOT NULL DEFAULT '[]',
  review_status TEXT NOT NULL DEFAULT 'NONE',
  conflict_reason TEXT,
  heading_detection_reason TEXT,
  precision_loss_detected BOOLEAN NOT NULL DEFAULT false,
  clean_record_id UUID REFERENCES clean_records(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sheet_id, physical_row_number)
);

CREATE INDEX IF NOT EXISTS idx_source_rows_upload_type
  ON source_rows(upload_id, row_type);

CREATE INDEX IF NOT EXISTS idx_source_rows_sheet_row
  ON source_rows(sheet_id, physical_row_number);

CREATE INDEX IF NOT EXISTS idx_source_rows_geo
  ON source_rows(upload_id, detected_area, street_group);

-- 4. User-approved Geographic Dictionaries & Alias Mappings (for Area & Street merge/rename)
CREATE TABLE IF NOT EXISTS geo_dictionaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id UUID REFERENCES uploads(id) ON DELETE CASCADE,
  level TEXT NOT NULL,
  parent_area TEXT,
  alias_label TEXT NOT NULL,
  canonical_label TEXT NOT NULL,
  group_type TEXT,
  is_approved BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_geo_dictionaries_lookup
  ON geo_dictionaries(level, alias_label, is_approved);

-- 5. Extend exports for Mode A / B / C ZIP tracking & progress
ALTER TABLE exports
  ADD COLUMN IF NOT EXISTS export_mode TEXT NOT NULL DEFAULT 'SINGLE_XLSX',
  ADD COLUMN IF NOT EXISTS is_zip BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS progress INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS artifact_manifest JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
