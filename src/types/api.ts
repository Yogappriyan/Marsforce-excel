export type UserRole = 'SUPER_ADMIN' | 'ADMIN' | 'DATA_PROCESSOR' | 'REVIEWER' | 'READ_ONLY';

export type PermissionCode =
  | 'view'
  | 'upload'
  | 'process'
  | 'edit'
  | 'approve'
  | 'export'
  | 'manage_users'
  | 'manage_settings'
  | 'delete';

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  isActive: boolean;
  permissions: PermissionCode[];
}

export type TargetField =
  | 'consumer_id'
  | 'distributor_id'
  | 'full_name'
  | 'address_combined'
  | 'street'
  | 'sub_area'
  | 'area'
  | 'city'
  | 'district'
  | 'state'
  | 'pin_code'
  | 'phone_raw'
  | 'phone_multi'
  | 'name_and_phone'
  | 'custom'
  | 'ignore';

export interface UploadDTO {
  id: string;
  original_filename: string;
  mime_type: string;
  file_extension: string;
  file_size_bytes: number;
  file_sha256: string;
  storage_driver: string;
  detected_encoding: string | null;
  status: string;
  total_rows: number;
  clean_count?: number;
  approved_count?: number;
  export_count?: number;
  uploaded_by_name?: string;
  created_at: string;
}

export interface UploadSheetDTO {
  id: string;
  upload_id: string;
  sheet_index: number;
  sheet_name: string;
  row_count: number;
  physical_row_count?: number;
  header_row_number?: number;
  include_hidden_rows?: boolean;
  column_count: number;
  headers: string[];
  preview_rows: Record<string, string>[];
  is_selected: boolean;
  selected_columns: string[];
}

export interface ColumnMappingItem {
  sourceIndex: number;
  sourceColumn: string;
  targetField: TargetField;
  customFieldKey?: string | null;
  detectionSource: 'RULE' | 'AI' | 'TEMPLATE' | 'MANUAL';
  confidence: number;
  reason?: string;
}

export interface MappingTemplateDTO {
  id: string;
  name: string;
  description: string | null;
  mappings: Array<{ sourceColumn: string; targetField: TargetField; customFieldKey?: string | null }>;
  updated_at: string;
}

export interface JobDTO {
  id: string;
  job_type: string;
  status: string;
  upload_id: string | null;
  sheet_id: string | null;
  original_filename?: string;
  total_records: number;
  processed_records: number;
  total_chunks: number;
  completed_chunks: number;
  error_summary: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface ValidationIssue {
  code: string;
  field: string;
  severity: 'ERROR' | 'WARN' | 'INFO';
  message: string;
}

export interface CleanRecordDTO {
  id: string;
  raw_record_id: string;
  upload_id: string;
  row_number: number;
  original_filename?: string;
  consumer_id?: string | null;
  distributor_id?: string | null;
  full_name: string | null;
  street: string | null;
  sub_area?: string | null;
  locality?: string | null;
  area: string | null;
  street_group?: string | null;
  group_type?: string | null;
  section_heading_context?: string | null;
  classification_source?: string | null;
  classification_confidence?: number;
  geographic_review_status?: string | null;
  geographic_conflict_reason?: string | null;
  original_sheet_name?: string | null;
  original_row_number?: number | null;
  precision_loss_detected?: boolean;
  city: string | null;
  district: string | null;
  state: string | null;
  pin_code: string | null;
  phone_e164: string | null;
  phone_display: string | null;
  secondary_phones: Array<{ raw: string; e164: string | null; display: string | null; valid: boolean }>;
  other_fields: Record<string, string>;
  provenance: Record<string, 'EXTRACTED' | 'STANDARDISED' | 'INFERRED'>;
  field_confidence: Record<string, number>;
  overall_confidence: number;
  status: 'PROCESSED' | 'VERIFIED' | 'NEEDS_REVIEW' | 'INVALID' | 'POTENTIAL_DUPLICATE' | 'APPROVED' | 'REJECTED';
  has_inferred_fields: boolean;
  issues: ValidationIssue[];
  raw_data: Record<string, string>;
  categories?: Array<{ type: string; value: string; path: string | null; source: string }>;
  created_at: string;
}

export interface RecordStats {
  PROCESSED: number;
  VERIFIED: number;
  NEEDS_REVIEW: number;
  INVALID: number;
  POTENTIAL_DUPLICATE: number;
  APPROVED: number;
  REJECTED: number;
  TOTAL: number;
}

export interface GeoStreetGroupItem {
  streetGroup: string;
  groupType: string;
  count: number;
  reviewRequiredCount: number;
  conflictCount: number;
  confirmedCount: number;
  sectionHeadings: string[];
}

export interface GeoAreaItem {
  areaKey: string;
  areaName: string;
  isUnassigned: boolean;
  totalCount: number;
  unidentifiedCount: number;
  needsReviewCount: number;
  conflictCount: number;
  confirmedCount: number;
  precisionLossCount: number;
  streetGroups: GeoStreetGroupItem[];
}

export interface GeoUploadSummaryDTO {
  upload: {
    id: string;
    original_filename: string;
    status: string;
    total_rows: number;
    sheet_id: string | null;
    sheet_name: string | null;
    header_row_number: number | null;
    physical_row_count: number | null;
    include_hidden_rows: boolean | null;
  };
  reconciliation: {
    totalPhysicalRows: number;
    COLUMN_HEADER: number;
    CUSTOMER_RECORD: number;
    SECTION_HEADING: number;
    EMPTY_SEPARATOR: number;
    SUBTOTAL_OR_REPORT_ROW: number;
    INVALID_RECORD: number;
    NEEDS_REVIEW: number;
    precisionLossRows: number;
    totalCustomerRecords: number;
    distinctAreasCount: number;
    distinctStreetGroupsCount: number;
    unassignedAreaCount: number;
    unidentifiedStreetCount: number;
    conflictCount: number;
    reviewRequiredCount: number;
  };
  areas: GeoAreaItem[];
  headings: Array<{
    physical_row_number: number;
    sheet_name: string;
    heading_text: string | null;
    detected_area: string | null;
    heading_detection_reason: string | null;
  }>;
}

export interface SourceRowAuditDTO {
  id: string;
  sheet_name: string;
  physical_row_number: number;
  row_type: string;
  raw_cells: Record<string, string>;
  format_meta: Record<string, any>;
  active_section_heading: string | null;
  detected_area: string | null;
  detected_sub_area: string | null;
  detected_street: string | null;
  street_group: string | null;
  group_type: string | null;
  classification_source: string | null;
  classification_confidence: number;
  review_status: string;
  conflict_reason: string | null;
  heading_detection_reason: string | null;
  precision_loss_detected: boolean;
  clean_record_id: string | null;
  full_name?: string | null;
  consumer_id?: string | null;
  phone_display?: string | null;
  clean_status?: string | null;
}

export interface CategoryRuleDTO {
  id: string;
  name: string;
  priority: number;
  category_type: string;
  category_value: string;
  conditions: {
    operator: 'AND' | 'OR';
    clauses: Array<{ field: string; matchType: 'EQUALS' | 'CONTAINS' | 'REGEX' | 'IN'; value: string }>;
  };
  is_active: boolean;
}

export interface DuplicateGroupDTO {
  id: string;
  upload_id: string | null;
  match_type: string;
  confidence: number;
  status: 'PENDING' | 'MERGED' | 'DISMISSED' | 'REVERTED';
  surviving_record_id: string | null;
  member_count: number;
  members_preview: Array<{
    id: string;
    fullName: string | null;
    phoneDisplay: string | null;
    city: string | null;
    street: string | null;
    pinCode: string | null;
    status: string;
    matchScore: number;
    matchReasons: string[];
    isSuggestedPrimary: boolean;
  }>;
  created_at: string;
}

export type ExportMode = 'AREA_WISE' | 'COMBINED_ZIP' | 'SINGLE_XLSX' | 'CSV';

export interface ExportDTO {
  id: string;
  format: 'XLSX' | 'CSV' | 'ZIP';
  export_mode?: ExportMode;
  is_zip?: boolean;
  progress?: number;
  artifact_manifest?: Record<string, any>;
  filename: string;
  split_by: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'EXPIRED';
  filters?: Record<string, any>;
  row_count: number;
  file_size_bytes: number | null;
  error_message: string | null;
  requested_by_name?: string;
  created_at: string;
  completed_at?: string | null;
}
