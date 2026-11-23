import type { TargetField } from '../../infrastructure/llm/LLMProvider.ts';
import type { PhysicalRowData } from '../uploads/fileParser.ts';
import { canonicalizeGeoLabel, extractSignificantTokens, inferGroupType, stripHeadingPrefix, type GeoGroupType } from './geoIntelligence.engine.ts';

export type RowClassificationType =
  | 'COLUMN_HEADER'
  | 'CUSTOMER_RECORD'
  | 'SECTION_HEADING'
  | 'EMPTY_SEPARATOR'
  | 'SUBTOTAL_OR_REPORT_ROW'
  | 'INVALID_RECORD'
  | 'NEEDS_REVIEW';

export interface RowClassificationResult {
  physicalRowNumber: number;
  rowType: RowClassificationType;
  sectionHeadingText: string | null;
  sectionHeadingGroupType: GeoGroupType | null;
  headingDetectionReason: string | null;
  classificationConfidence: number;
  hasCustomerIdentity: boolean;
  isSubTotalOrBanner: boolean;
}

const REPORT_OR_SUBTOTAL_RE =
  /^(?:sub\s*total|subtotal|grand\s*total|total(?:\s+customers|\s+records|\s+count|\s*:)?|page\s+\d+|printed\s+on|generated\s+(?:on|at)|report\s*(?:date|summary|title)?|end\s+of\s+report|summary\s*:?|s\.?\s*no\.?\s*total)/i;

const EXPLICIT_SECTION_PREFIX_RE =
  /^(?:section|group|street\s*group|locality|street|road|area|zone|sub[\s-]?area)\s*[:\-]\s*(.+)/i;

const GEO_HEADING_CUE_RE =
  /(?:\b(?:street|st|road|rd|main\s*road|main\s*rd|cross|lane|avenue|ave|salai|nagar|colony|layout|extension|extn|enclave|gardens|puram|pudur|palayam|estate|phase|block|sector|village|bypass|ward|zone)\b|(?:தெரு|சாலை|நகர்|காலனி|புதூர்|பாளையம்|குறுக்கு))/i;

const PHONE_LIKE_RE = /(?:\+?91[\s-]?)?(?:0)?[6-9]\d{4}[\s-]?\d{5}|\b\d{8,14}\b/;

export interface FieldMappingSummary {
  consumerIdCols: string[];
  distributorIdCols: string[];
  nameCols: string[];
  phoneCols: string[];
  addressCols: string[];
  streetCols: string[];
  areaCols: string[];
  otherCols: string[];
}

export function summarizeMappedColumns(
  mappings: Array<{ sourceColumn: string; targetField: TargetField }>
): FieldMappingSummary {
  const s: FieldMappingSummary = {
    consumerIdCols: [],
    distributorIdCols: [],
    nameCols: [],
    phoneCols: [],
    addressCols: [],
    streetCols: [],
    areaCols: [],
    otherCols: [],
  };
  for (const m of mappings) {
    if (m.targetField === 'ignore') continue;
    if (m.targetField === 'consumer_id') s.consumerIdCols.push(m.sourceColumn);
    else if (m.targetField === 'distributor_id') s.distributorIdCols.push(m.sourceColumn);
    else if (m.targetField === 'full_name' || m.targetField === 'name_and_phone') s.nameCols.push(m.sourceColumn);
    else if (m.targetField === 'phone_raw' || m.targetField === 'phone_multi') s.phoneCols.push(m.sourceColumn);
    else if (m.targetField === 'address_combined') s.addressCols.push(m.sourceColumn);
    else if (m.targetField === 'street') s.streetCols.push(m.sourceColumn);
    else if (m.targetField === 'area' || m.targetField === 'sub_area') s.areaCols.push(m.sourceColumn);
    else s.otherCols.push(m.sourceColumn);
  }
  return s;
}

export function classifyPhysicalRow(params: {
  row: PhysicalRowData;
  headerRowNumber: number;
  mappingSummary: FieldMappingSummary;
  nextRows?: PhysicalRowData[];
  totalColumns: number;
}): RowClassificationResult {
  const { row, headerRowNumber, mappingSummary, nextRows = [] } = params;

  if (row.physicalRowNumber === headerRowNumber) {
    return {
      physicalRowNumber: row.physicalRowNumber,
      rowType: 'COLUMN_HEADER',
      sectionHeadingText: null,
      sectionHeadingGroupType: null,
      headingDetectionReason: 'Detected worksheet column header row',
      classificationConfidence: 1.0,
      hasCustomerIdentity: false,
      isSubTotalOrBanner: false,
    };
  }

  if (row.isBlank) {
    return {
      physicalRowNumber: row.physicalRowNumber,
      rowType: 'EMPTY_SEPARATOR',
      sectionHeadingText: null,
      sectionHeadingGroupType: null,
      headingDetectionReason: null,
      classificationConfidence: 1.0,
      hasCustomerIdentity: false,
      isSubTotalOrBanner: false,
    };
  }

  const nonEmptyVals = row.orderedCells.map((c) => c.trim()).filter(Boolean);
  const joinedText = nonEmptyVals.join(' ').trim();

  // Pre-header title/report banner rows
  if (row.physicalRowNumber < headerRowNumber) {
    return {
      physicalRowNumber: row.physicalRowNumber,
      rowType: 'SUBTOTAL_OR_REPORT_ROW',
      sectionHeadingText: null,
      sectionHeadingGroupType: null,
      headingDetectionReason: 'Report banner or title row before table headers',
      classificationConfidence: 0.95,
      hasCustomerIdentity: false,
      isSubTotalOrBanner: true,
    };
  }

  // Repeated header row embedded mid-sheet (e.g. page-break printed header)
  const headerRepeatHits = nonEmptyVals.filter((v) =>
    /^(consumer\s*(no|number|id)|customer\s*name|mobile|phone|address|area\s*name|sl\.?\s*no)$/i.test(v)
  ).length;
  if (headerRepeatHits >= 3) {
    return {
      physicalRowNumber: row.physicalRowNumber,
      rowType: 'COLUMN_HEADER',
      sectionHeadingText: null,
      sectionHeadingGroupType: null,
      headingDetectionReason: 'Repeated column header row embedded in worksheet',
      classificationConfidence: 0.94,
      hasCustomerIdentity: false,
      isSubTotalOrBanner: false,
    };
  }

  const getJoined = (cols: string[]) =>
    cols.map((c) => String(row.cellsByHeader[c] ?? '').trim()).filter(Boolean).join(' ');

  const consumerIdVal = getJoined(mappingSummary.consumerIdCols);
  const nameVal = getJoined(mappingSummary.nameCols);
  const phoneVal = getJoined(mappingSummary.phoneCols);
  const addressVal = getJoined(mappingSummary.addressCols);
  const streetVal = getJoined(mappingSummary.streetCols);

  const consumerIdLooksLikeHeading = Boolean(
    consumerIdVal &&
      (row.isMergedRow ||
        GEO_HEADING_CUE_RE.test(consumerIdVal) ||
        EXPLICIT_SECTION_PREFIX_RE.test(consumerIdVal) ||
        (!/\d{3,}/.test(consumerIdVal) &&
          nonEmptyVals.length <= 2 &&
          (row.isBoldRow || row.isCenteredRow || row.isUppercaseRow)))
  );

  const hasConsumerId = Boolean(
    consumerIdVal && !REPORT_OR_SUBTOTAL_RE.test(consumerIdVal) && !consumerIdLooksLikeHeading
  );
  const hasPhone = Boolean(phoneVal && /\d{6,}/.test(phoneVal)) || (!nameVal && PHONE_LIKE_RE.test(joinedText));
  const hasName = Boolean(nameVal);

  // Explicit subtotal / footer / count rows (must NEVER be misclassified as section headings or customers)
  if (
    !hasPhone &&
    !hasConsumerId &&
    (REPORT_OR_SUBTOTAL_RE.test(joinedText) ||
      (nonEmptyVals.length <= 2 && /^(total|count|grand\s+total|sub\s*total)\b/i.test(nonEmptyVals[0] || '')))
  ) {
    return {
      physicalRowNumber: row.physicalRowNumber,
      rowType: 'SUBTOTAL_OR_REPORT_ROW',
      sectionHeadingText: null,
      sectionHeadingGroupType: null,
      headingDetectionReason: 'Matched subtotal or report footer pattern',
      classificationConfidence: 0.95,
      hasCustomerIdentity: false,
      isSubTotalOrBanner: true,
    };
  }

  // Determine candidate text for section heading analysis
  const explicitPrefixMatch = joinedText.match(EXPLICIT_SECTION_PREFIX_RE);
  const fewNonEmptyCells = row.nonEmptyCount <= Math.max(2, Math.floor(params.totalColumns * 0.35));

  // If the row has BOTH a consumer ID OR a phone number, it's definitely a customer row (even if uppercase!)
  // Or if it has a customer name + non-trivial fields and isn't merged/standalone section label:
  const hasCustomerIdentity = hasConsumerId || hasPhone || (hasName && row.nonEmptyCount >= 3 && !row.isMergedRow);

  if (!hasCustomerIdentity) {
    // Evaluate multi-signal Section Heading evidence
    const reasons: string[] = [];
    let score = 0;

    // Signal 1: Missing customer identifiers
    if (!hasConsumerId && !hasPhone) {
      score += 0.2;
      reasons.push('missing customer ID & mobile');
    }

    // Signal 2: Explicit heading prefix ("SECTION:", "GROUP:", "STREET:", "LOCALITY:")
    if (explicitPrefixMatch) {
      score += 0.5;
      reasons.push('explicit section prefix');
    }

    // Signal 3: Formatting indicators (merged banner, bold, centered, uppercase)
    if (row.isMergedRow) {
      score += 0.25;
      reasons.push('merged row');
    }
    if (row.isBoldRow) {
      score += 0.2;
      reasons.push('bold styling');
    }
    if (row.isCenteredRow) {
      score += 0.15;
      reasons.push('center aligned');
    }
    if (row.isUppercaseRow && nonEmptyVals.length <= 2) {
      score += 0.15;
      reasons.push('uppercase standalone label');
    }

    // Signal 4: Location/street/locality text without door/flat numbers (door numbers suggest an address fragment rather than a section heading)
    const candidateLabel = explicitPrefixMatch
      ? explicitPrefixMatch[1].trim()
      : nonEmptyVals.length === 1
        ? nonEmptyVals[0]
        : [streetVal, addressVal, nameVal, ...nonEmptyVals].find((v) => v && GEO_HEADING_CUE_RE.test(v)) || nonEmptyVals[0] || '';

    const hasGeoCue = GEO_HEADING_CUE_RE.test(candidateLabel);
    if (hasGeoCue) {
      score += 0.3;
      reasons.push('contains street/locality token');
    } else if (row.nonEmptyCount === 1 && candidateLabel.length >= 3 && candidateLabel.length <= 80 && !/^\d+$/.test(candidateLabel)) {
      if (row.isMergedRow || row.isBoldRow || row.isCenteredRow || row.isUppercaseRow) {
        score += 0.25;
        reasons.push('single prominent text cell');
      }
    }

    // Signal 5: Lookahead neighbour corroboration (subsequent customer rows mention tokens from this heading)
    const headingTokens = extractSignificantTokens(stripHeadingPrefix(candidateLabel));
    if (headingTokens.length > 0 && nextRows.length > 0) {
      let neighbourMatches = 0;
      for (const nr of nextRows.slice(0, 5)) {
        if (nr.isBlank) continue;
        const nrJoined = nr.orderedCells.join(' ').toLowerCase();
        if (headingTokens.some((tok) => nrJoined.includes(tok))) {
          neighbourMatches++;
        }
      }
      if (neighbourMatches >= 1) {
        score += 0.25;
        reasons.push(`corroborated by ${neighbourMatches} neighbouring row(s)`);
      }
    }

    // Guard against customer row with only name (no geo cue, no formatting, not merged, has other non-geo data)
    const cleanCandidate = canonicalizeGeoLabel(stripHeadingPrefix(candidateLabel));
    const looksLikeHeading =
      Boolean(cleanCandidate) &&
      fewNonEmptyCells &&
      score >= 0.55 &&
      !/^\d+$/.test(cleanCandidate!);

    if (looksLikeHeading && cleanCandidate) {
      return {
        physicalRowNumber: row.physicalRowNumber,
        rowType: 'SECTION_HEADING',
        sectionHeadingText: cleanCandidate,
        sectionHeadingGroupType: inferGroupType(cleanCandidate),
        headingDetectionReason: reasons.join('; '),
        classificationConfidence: Number(Math.min(0.99, score).toFixed(3)),
        hasCustomerIdentity: false,
        isSubTotalOrBanner: false,
      };
    }
  }

  // Otherwise this is a Customer Data row (valid, invalid, or needs review will be finalized after field cleaning + geo check)
  return {
    physicalRowNumber: row.physicalRowNumber,
    rowType: 'CUSTOMER_RECORD',
    sectionHeadingText: null,
    sectionHeadingGroupType: null,
    headingDetectionReason: null,
    classificationConfidence: 0.9,
    hasCustomerIdentity: true,
    isSubTotalOrBanner: false,
  };
}
