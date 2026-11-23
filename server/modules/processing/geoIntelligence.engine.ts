import { cleanText, normalizeForMatch, smartTitleCase } from './cleaning.engine.ts';

export type GeoGroupType =
  | 'STREET'
  | 'ROAD'
  | 'CROSS_STREET'
  | 'LANE'
  | 'COLONY'
  | 'NAGAR_LOCALITY'
  | 'LAYOUT'
  | 'SUB_AREA'
  | 'SECTION_HEADING'
  | 'UNIDENTIFIED';

export type GeoReviewStatus =
  | 'CONFIRMED'
  | 'AUTO'
  | 'CONFLICT'
  | 'NEEDS_REVIEW'
  | 'UNIDENTIFIED'
  | 'APPROVED';

export interface GeoDictionaryEntry {
  level: 'AREA' | 'SUB_AREA' | 'STREET';
  parentArea: string | null;
  aliasLabel: string;
  canonicalLabel: string;
  groupType?: string | null;
}

export interface ParsedAddressGeo {
  originalAddress: string;
  doorOrHouseNo: string | null;
  street: string | null;
  subArea: string | null;
  locality: string | null;
  areaFromAddress: string | null;
  city: string | null;
  district: string | null;
  state: string | null;
  pinCode: string | null;
  streetGroup: string;
  groupType: GeoGroupType;
  confidence: number;
  evidenceTokens: string[];
}

export interface ResolvedGeographicClassification {
  area: string | null;
  subArea: string | null;
  locality: string | null;
  street: string | null;
  streetGroup: string;
  groupType: GeoGroupType;
  sectionHeadingContext: string | null;
  classificationSource: string;
  classificationConfidence: number;
  geographicReviewStatus: GeoReviewStatus;
  geographicConflictReason: string | null;
}

const STREET_TOKEN_RE =
  /(?:\b(?:\d+(?:st|nd|rd|th)?\s+)?(?:main\s+road|main\s+rd|cross\s+street|cross\s+st|cross\s+road|cross|street|st|road|rd|lane|ln|avenue|ave|bylane|by-lane|high\s+road|high\s+rd|bypass|ring\s+road|trunk\s+road|salai|salai\s+road)\b|(?:\b\d+(?:st|nd|rd|th)\b)|(?:தெரு|சாலை|மெயின்\s*ரோடு|குறுக்கு\s*தெரு|சந்து))/i;

const CROSS_TOKEN_RE = /(?:\bcross(?:\s*(?:st|street|road|rd))?\b|குறுக்கு\s*தெரு)/i;
const ROAD_TOKEN_RE = /(?:\b(?:road|rd|main\s+road|main\s+rd|high\s+road|high\s+rd|salai|bypass|avenue|ave)\b|சாலை|ரோடு)/i;
const LANE_TOKEN_RE = /(?:\b(?:lane|ln|bylane|by-lane)\b|சந்து)/i;

const LOCALITY_TOKEN_RE =
  /(?:\b(?:nagar|colony|layout|extension|extn|enclave|gardens|garden|puram|pudur|palayam|estate|industrial\s+estate|phase|block|sector|village|hamlet|residency|township|camp)\b|(?:நகர்|காலனி|புதூர்|பாளையம்|லேஅவுட்))/i;

const DOOR_NO_PREFIX_RE =
  /^(?:(?:d\.?\s*no\.?|door\s*no\.?|house\s*no\.?|flat\s*no\.?|plot\s*no\.?|plot|flat|apt|no\.?)\s*[:\-]?\s*[\da-z\/-]+(?:\s*,\s*|\s+))|^(?:\d{1,4}(?:[\/\-][a-z\d]{1,5})?\s*,\s*)/i;

const CITY_OR_STATE_STOP_RE =
  /^(?:india|tn|tamil\s*nadu|tamilnadu|ka|karnataka|kl|kerala|ap|andhra\s*pradesh|ts|telangana|mh|maharashtra|dl|delhi|wb|west\s*bengal|madurai|chennai|coimbatore|tirunelveli|salem|trichy|tiruchirappalli|erode|thanjavur|vellore|thoothukudi|nagercoil|bengaluru|bangalore|hyderabad|mumbai|pune|kochi|kolkata)$/i;

const GENERIC_GEO_WORDS = new Set([
  'street',
  'st',
  'road',
  'rd',
  'main',
  'cross',
  'lane',
  'ln',
  'avenue',
  'ave',
  'nagar',
  'colony',
  'layout',
  'extension',
  'extn',
  'enclave',
  'block',
  'phase',
  'sector',
  'area',
  'section',
  'group',
  'locality',
  'sub',
  'no',
  'door',
  'plot',
  'flat',
  'house',
]);

const GEO_ACRONYMS = new Set([
  'tn',
  'ka',
  'kl',
  'ap',
  'ts',
  'mh',
  'dl',
  'wb',
  'gj',
  'rj',
  'up',
  'gst',
  'sipcot',
  'sidco',
  'bhel',
  'sez',
  'nh',
  'sh',
  'mg',
  'kk',
  'tvs',
  'tnhb',
  'lic',
  'it',
]);

export function normalizeGeoGroupKey(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .normalize('NFC')
    .replace(/^[\-:;|,.]+|[\-:;|,.]+$/g, '')
    .replace(/\s*-\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function naturalGeoCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function smartGeoTitleCase(text: string): string {
  if (/^[=+\-@\t\r]/.test(text)) return text;
  return text
    .split(' ')
    .map((word) => {
      if (!word) return '';
      if (/[^\u0000-\u007F]/.test(word)) return word;
      const bare = word.replace(/\./g, '').toLowerCase();
      if (GEO_ACRONYMS.has(bare)) return word.toUpperCase();
      if (/^[a-z](?:\.[a-z])+\.?$/i.test(word)) return word.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

export function canonicalizeGeoLabel(raw: string | null | undefined): string | null {
  const cleaned = cleanText(raw);
  if (!cleaned) return null;

  // Preserve harmless separators like "AREA A - 1" while trimming outer noise and collapsing spaces
  const normalized = cleaned
    .replace(/^[\-:;|,.]+|[\-:;|,.]+$/g, '')
    .replace(/\s*-\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return null;

  // Standardize harmless abbreviation endings ONLY (never rewrite numbers/ordinals or distinct spellings)
  const standardized = normalized
    .replace(/\bSt\.?$/i, 'Street')
    .replace(/\bRd\.?$/i, 'Road')
    .replace(/\bAve\.?$/i, 'Avenue')
    .replace(/\bExtn\.?$/i, 'Extension')
    .replace(/\bLn\.?$/i, 'Lane');

  return smartGeoTitleCase(standardized);
}

export function stripHeadingPrefix(raw: string): string {
  return raw
    .replace(/^(?:section|group|street\s*group|locality|street|road|area|zone|sub[\s-]?area)\s*[:\-]\s*/i, '')
    .trim();
}

export function inferGroupType(label: string | null): GeoGroupType {
  if (!label || /^unidentified$/i.test(label.trim())) return 'UNIDENTIFIED';
  if (CROSS_TOKEN_RE.test(label)) return 'CROSS_STREET';
  if (LANE_TOKEN_RE.test(label)) return 'LANE';
  if (ROAD_TOKEN_RE.test(label)) return 'ROAD';
  if (/(?:\bstreet\b|\bst\b|தெரு)/i.test(label)) return 'STREET';
  if (/(?:\bcolony\b|காலனி)/i.test(label)) return 'COLONY';
  if (/(?:\blayout\b|லேஅவுட்)/i.test(label)) return 'LAYOUT';
  if (/(?:\bnagar\b|நகர்)/i.test(label)) return 'NAGAR_LOCALITY';
  if (LOCALITY_TOKEN_RE.test(label)) return 'SUB_AREA';
  return 'SUB_AREA';
}

export function extractSignificantTokens(text: string | null | undefined): string[] {
  if (!text) return [];
  const norm = normalizeForMatch(text) || '';
  if (!norm) return [];
  const rawTokens = norm.split(' ').filter(Boolean);
  const out: string[] = [];
  for (const t of rawTokens) {
    // Normalize ordinal suffixes cleanly ("4th" -> "4", "2nd" -> "2") while NEVER dropping numeric identity!
    const numNorm = t.replace(/^(\d+)(?:st|nd|rd|th)$/i, '$1');
    if (GENERIC_GEO_WORDS.has(numNorm)) continue;
    if (numNorm.length === 1 && !/^\d$/.test(numNorm)) continue;
    out.push(numNorm);
  }
  return out;
}

export function extractNumberTokens(text: string | null | undefined): string[] {
  if (!text) return [];
  const matches = text.toLowerCase().match(/\b\d+(?:st|nd|rd|th)?\b/g) || [];
  return matches.map((m) => m.replace(/(?:st|nd|rd|th)$/i, ''));
}

export function compareGeoTokens(
  addressText: string | null,
  headingText: string | null
): 'MATCH' | 'CONFLICT' | 'INSUFFICIENT' {
  if (!headingText) return 'INSUFFICIENT';
  if (!addressText || !addressText.trim()) return 'INSUFFICIENT';

  const headingTokens = extractSignificantTokens(headingText);
  if (headingTokens.length === 0) return 'INSUFFICIENT';

  const addrTokens = extractSignificantTokens(addressText);
  if (addrTokens.length === 0) return 'INSUFFICIENT';

  // Extract explicit street/locality segment from address for comparison
  const parsedAddr = parseAddressHierarchy(addressText);
  const candidateAddrPhrase = parsedAddr.street || parsedAddr.subArea || parsedAddr.locality;
  if (!candidateAddrPhrase && !STREET_TOKEN_RE.test(addressText) && !LOCALITY_TOKEN_RE.test(addressText)) {
    // Address has no recognizable street or locality info (e.g. only door no / PIN / city)
    return 'INSUFFICIENT';
  }

  // Strict check: if BOTH have numeric street/cross identifiers (e.g. "Cross 4" vs "Cross 5", "1st" vs "2nd") and they differ -> CONFLICT!
  const headingNums = extractNumberTokens(headingText);
  const phraseNums = extractNumberTokens(candidateAddrPhrase || addressText);
  if (headingNums.length > 0 && phraseNums.length > 0) {
    const numMatch = headingNums.some((hn) => phraseNums.includes(hn));
    if (!numMatch) {
      return 'CONFLICT';
    }
  }

  const addrSet = new Set(addrTokens);
  const overlap = headingTokens.filter((ht) => addrSet.has(ht));
  if (overlap.length > 0) {
    // Even with shared locality word (e.g. "Gandhi Nagar Cross 4" vs "Gandhi Nagar Cross 5"), check differing specific tokens
    const headingNorm = (normalizeForMatch(headingText) || '').replace(/\b(\d+)(?:st|nd|rd|th)\b/g, '$1');
    const addrNorm = (normalizeForMatch(candidateAddrPhrase || addressText) || '').replace(/\b(\d+)(?:st|nd|rd|th)\b/g, '$1');
    if (headingNorm === addrNorm || addrNorm.includes(headingNorm) || headingNorm.includes(addrNorm)) {
      return 'MATCH';
    }
    // Check if candidate phrase names a different street/cross keyword altogether
    if (overlap.length >= Math.ceil(headingTokens.length * 0.5)) {
      if (headingNums.length > 0 && phraseNums.length > 0 && !headingNums.some((hn) => phraseNums.includes(hn))) {
        return 'CONFLICT';
      }
      return 'MATCH';
    }
  }

  return 'CONFLICT';
}

export function parseAddressHierarchy(rawAddress: string | null | undefined): ParsedAddressGeo {
  const originalAddress = rawAddress ? String(rawAddress).trim() : '';
  if (!originalAddress) {
    return {
      originalAddress: '',
      doorOrHouseNo: null,
      street: null,
      subArea: null,
      locality: null,
      areaFromAddress: null,
      city: null,
      district: null,
      state: null,
      pinCode: null,
      streetGroup: 'UNIDENTIFIED',
      groupType: 'UNIDENTIFIED',
      confidence: 0,
      evidenceTokens: [],
    };
  }

  let working = originalAddress.normalize('NFC').replace(/\s+/g, ' ').trim();
  let pinCode: string | null = null;
  const pinMatch = working.match(/\b([1-9]\d{5})\b/);
  if (pinMatch) {
    pinCode = pinMatch[1];
    working = working.replace(pinMatch[0], ' ').replace(/\s*,\s*$/, '').trim();
  }

  let doorOrHouseNo: string | null = null;
  const doorPrefixMatch = working.match(DOOR_NO_PREFIX_RE);
  if (doorPrefixMatch) {
    doorOrHouseNo = doorPrefixMatch[0].replace(/,\s*$/, '').trim();
    working = working.slice(doorPrefixMatch[0].length).trim();
  }

  const rawSegments = working
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const filteredSegments: string[] = [];
  let city: string | null = null;
  let state: string | null = null;

  for (let i = 0; i < rawSegments.length; i++) {
    const seg = rawSegments[i];
    const cleanSeg = seg.replace(/\./g, '').trim();
    if (i >= rawSegments.length - 2 && CITY_OR_STATE_STOP_RE.test(cleanSeg)) {
      if (/^(?:tn|tamil\s*nadu|tamilnadu|ka|karnataka|kl|kerala|ap|andhra\s*pradesh|ts|telangana|mh|maharashtra|dl|delhi|wb|west\s*bengal|india)$/i.test(cleanSeg)) {
        state = smartTitleCase(cleanSeg);
      } else {
        city = smartTitleCase(cleanSeg);
      }
      continue;
    }
    filteredSegments.push(seg);
  }

  // Strip leading house numbers within the first remaining segment if any
  const cleanedSegments = filteredSegments
    .map((seg, idx) => {
      if (idx === 0) {
        const m = seg.match(/^(?:(?:no\.?|d\.?no\.?|door\s*no\.?|plot\s*no\.?|plot|flat)\s*[:\-]?\s*[\da-z\/-]+\s+|\d{1,4}[\/\-]?[a-z]?\s+)/i);
        if (m && seg.length > m[0].length + 3) {
          if (!doorOrHouseNo) doorOrHouseNo = m[0].trim();
          return seg.slice(m[0].length).trim();
        }
      }
      return seg;
    })
    .filter(Boolean);

  let street: string | null = null;
  let subArea: string | null = null;
  let areaFromAddress: string | null = null;
  const evidenceTokens: string[] = [];

  for (const seg of cleanedSegments) {
    if (!street && STREET_TOKEN_RE.test(seg)) {
      street = canonicalizeGeoLabel(seg);
      evidenceTokens.push(seg);
    } else if (!subArea && LOCALITY_TOKEN_RE.test(seg)) {
      subArea = canonicalizeGeoLabel(seg);
      evidenceTokens.push(seg);
    } else if (!areaFromAddress && seg.length >= 3 && !/^\d+$/.test(seg)) {
      // Only treat remaining mid-segment as potential area/locality if there's already another segment
      if (cleanedSegments.length >= 2 && (street || subArea)) {
        areaFromAddress = canonicalizeGeoLabel(seg);
      } else if (!street && !subArea && cleanedSegments.length === 1) {
        // Single segment with no street/locality suffix -> ambiguous unless Tamil/descriptive words exist
        if (/[^\u0000-\u007F]/.test(seg) || seg.split(/\s+/).length >= 2) {
          // Leave street null when there's zero street/locality evidence; don't fabricate!
        }
      }
    }
  }

  // Handle combined single segment like "14 Gandhi Nagar 2nd Cross" where locality + street appear together
  if (!street && subArea && /\b\d+(?:st|nd|rd|th)?\s+cross\b/i.test(originalAddress)) {
    street = subArea;
  }

  // Case H (Locality within Locality): preserve subArea qualifier alongside street when distinct (e.g. "Main Road, West Anna Nagar")
  const primaryGroup =
    street && subArea && !normalizeGeoGroupKey(street).includes(normalizeGeoGroupKey(subArea))
      ? `${street}, ${subArea}`
      : street || subArea || 'UNIDENTIFIED';
  const groupType: GeoGroupType =
    primaryGroup === 'UNIDENTIFIED' ? 'UNIDENTIFIED' : inferGroupType(street || primaryGroup);

  let confidence = 0.25;
  if (street) confidence = 0.88;
  else if (subArea) confidence = 0.80;
  if (street && subArea) confidence = 0.93;

  return {
    originalAddress,
    doorOrHouseNo,
    street,
    subArea,
    locality: subArea,
    areaFromAddress,
    city,
    district: null,
    state,
    pinCode,
    streetGroup: primaryGroup,
    groupType,
    confidence: Number(confidence.toFixed(3)),
    evidenceTokens,
  };
}

export function applyDictionaryAlias(
  rawLabel: string | null,
  level: 'AREA' | 'SUB_AREA' | 'STREET',
  parentArea: string | null,
  dictionaries: GeoDictionaryEntry[]
): string | null {
  if (!rawLabel) return null;
  const normInput = rawLabel.trim().toLowerCase().replace(/\s+/g, ' ');
  for (const d of dictionaries) {
    if (d.level !== level) continue;
    if (d.parentArea && parentArea && d.parentArea.toLowerCase() !== parentArea.toLowerCase()) continue;
    if (d.aliasLabel.trim().toLowerCase().replace(/\s+/g, ' ') === normInput) {
      return d.canonicalLabel;
    }
  }
  return rawLabel;
}

export function resolveGeographicClassification(params: {
  explicitArea: string | null;
  explicitSubArea?: string | null;
  explicitStreet: string | null;
  rawAddress: string | null;
  city: string | null;
  activeSectionHeading: string | null;
  dictionaries?: GeoDictionaryEntry[];
  aiSuggestion?: {
    suggestedArea?: string | null;
    suggestedSubArea?: string | null;
    suggestedStreet?: string | null;
    groupType?: string;
    evidence?: string;
    confidence?: number;
    needsReview?: boolean;
    explanation?: string;
  } | null;
}): ResolvedGeographicClassification {
  const dicts = params.dictionaries || [];
  const parsedAddr = parseAddressHierarchy(params.rawAddress);

  // 1. Area Identification (Explicit source column -> Dictionary alias -> Embedded address evidence -> City fallback only if explicit? NO: never confuse city with area unless explicit area missing and evidence exists; keep NULL/UNASSIGNED if no evidence)
  let area: string | null = canonicalizeGeoLabel(params.explicitArea);
  let areaSource: string | null = area ? 'EXPLICIT_COLUMN' : null;

  if (!area && parsedAddr.areaFromAddress) {
    area = canonicalizeGeoLabel(parsedAddr.areaFromAddress);
    areaSource = 'ADDRESS_PARSED';
  }
  if (area) {
    const aliasedArea = applyDictionaryAlias(area, 'AREA', null, dicts);
    if (aliasedArea && aliasedArea !== area) {
      area = aliasedArea;
      areaSource = 'DICTIONARY_ALIAS';
    }
  } else if (params.aiSuggestion?.suggestedArea && params.rawAddress) {
    const ev = (params.aiSuggestion.evidence || params.aiSuggestion.suggestedArea).toLowerCase();
    if (ev && params.rawAddress.toLowerCase().includes(ev)) {
      area = canonicalizeGeoLabel(params.aiSuggestion.suggestedArea);
      areaSource = 'GEMINI_AI';
    }
  }

  // 2. SubArea / Locality
  let subArea =
    canonicalizeGeoLabel(params.explicitSubArea) ||
    parsedAddr.subArea ||
    (params.aiSuggestion?.suggestedSubArea && params.rawAddress?.toLowerCase().includes(params.aiSuggestion.suggestedSubArea.toLowerCase())
      ? canonicalizeGeoLabel(params.aiSuggestion.suggestedSubArea)
      : null);

  if (subArea) {
    subArea = applyDictionaryAlias(subArea, 'SUB_AREA', area, dicts) || subArea;
  }

  // 3. Explicit Street vs Parsed Street vs Section Context vs AI
  const explicitStreet = canonicalizeGeoLabel(params.explicitStreet);
  const addressStreet = explicitStreet || parsedAddr.street || null;
  const addressPrimary = addressStreet || subArea || null;
  const cleanHeading = params.activeSectionHeading
    ? canonicalizeGeoLabel(stripHeadingPrefix(params.activeSectionHeading))
    : null;

  let street: string | null = addressStreet;
  let streetGroup = 'UNIDENTIFIED';
  let groupType: GeoGroupType = 'UNIDENTIFIED';
  let classificationSource = 'UNIDENTIFIED';
  let classificationConfidence = 0.2;
  let geographicReviewStatus: GeoReviewStatus = 'UNIDENTIFIED';
  let geographicConflictReason: string | null = null;

  if (cleanHeading) {
    const cmpText = [explicitStreet, params.rawAddress].filter(Boolean).join(', ');
    const cmp = compareGeoTokens(cmpText, cleanHeading);

    if (cmp === 'MATCH') {
      streetGroup = cleanHeading;
      if (!street) street = cleanHeading;
      groupType = inferGroupType(streetGroup);
      classificationSource = 'SECTION_AND_ADDRESS';
      classificationConfidence = 0.96;
      geographicReviewStatus = 'CONFIRMED';
    } else if (cmp === 'CONFLICT') {
      // Customer's own address explicitly identifies a different street/locality than the section heading!
      streetGroup = addressPrimary || 'UNIDENTIFIED';
      groupType = inferGroupType(streetGroup);
      classificationSource = 'ADDRESS_CONFLICT_DETECTED';
      classificationConfidence = 0.65;
      geographicReviewStatus = 'CONFLICT';
      geographicConflictReason = `Address specifies "${addressPrimary || cmpText}" which conflicts with active section heading "${cleanHeading}".`;
    } else {
      // Address lacks street/locality detail -> use active heading ONLY as contextual evidence + flag NEEDS_REVIEW
      streetGroup = cleanHeading;
      if (!street) street = null; // preserve absence of explicit street in address!
      groupType = inferGroupType(streetGroup);
      classificationSource = 'SECTION_CONTEXT';
      classificationConfidence = 0.72;
      geographicReviewStatus = 'NEEDS_REVIEW';
      geographicConflictReason = `Address lacks explicit street/locality tokens; provisionally grouped under section heading "${cleanHeading}" for human review.`;
    }
  } else {
    // No active section heading -> use explicit street, parsed address hierarchy, dictionary, or verified Gemini suggestion
    if (explicitStreet) {
      street = explicitStreet;
      streetGroup = explicitStreet;
      groupType = inferGroupType(streetGroup);
      classificationSource = 'EXPLICIT_COLUMN';
      classificationConfidence = 0.94;
      geographicReviewStatus = 'CONFIRMED';
    } else if (parsedAddr.streetGroup !== 'UNIDENTIFIED') {
      // Avoid repeating the parent Area inside streetGroup if subArea equals the Area name
      const subAreaSameAsArea = Boolean(
        area && parsedAddr.subArea && normalizeGeoGroupKey(parsedAddr.subArea) === normalizeGeoGroupKey(area)
      );
      streetGroup =
        subAreaSameAsArea && parsedAddr.street
          ? parsedAddr.street
          : parsedAddr.streetGroup;
      groupType = parsedAddr.groupType;
      classificationSource = 'RULE_ADDRESS';
      classificationConfidence = parsedAddr.confidence;
      geographicReviewStatus = parsedAddr.confidence >= 0.85 ? 'AUTO' : 'NEEDS_REVIEW';
    } else if (params.aiSuggestion?.suggestedStreet && params.rawAddress) {
      const ev = (params.aiSuggestion.evidence || params.aiSuggestion.suggestedStreet).toLowerCase();
      if (ev && params.rawAddress.toLowerCase().includes(ev)) {
        const aiStreet = canonicalizeGeoLabel(params.aiSuggestion.suggestedStreet);
        if (aiStreet) {
          street = aiStreet;
          streetGroup = aiStreet;
          groupType =
            (params.aiSuggestion.groupType as GeoGroupType) || inferGroupType(aiStreet);
          classificationSource = 'GEMINI_AI';
          classificationConfidence = Math.min(0.84, params.aiSuggestion.confidence || 0.75);
          geographicReviewStatus = 'NEEDS_REVIEW';
          geographicConflictReason =
            params.aiSuggestion.explanation ||
            'AI-assisted address classification requires human confirmation.';
        }
      }
    }
  }

  // Apply approved street alias dictionary if not unidentified
  if (streetGroup !== 'UNIDENTIFIED') {
    const aliasedStreet = applyDictionaryAlias(streetGroup, 'STREET', area, dicts);
    if (aliasedStreet && aliasedStreet !== streetGroup) {
      streetGroup = aliasedStreet;
      if (classificationSource === 'RULE_ADDRESS') classificationSource = 'DICTIONARY_ALIAS';
    }
  } else {
    geographicReviewStatus = 'UNIDENTIFIED';
    if (!geographicConflictReason) {
      geographicConflictReason = 'No street, road, cross street, or locality could be reliably identified from the source address.';
    }
  }

  return {
    area,
    subArea,
    locality: subArea,
    street,
    streetGroup,
    groupType,
    sectionHeadingContext: cleanHeading,
    classificationSource: areaSource && classificationSource === 'UNIDENTIFIED' ? `${areaSource}+UNIDENTIFIED` : classificationSource,
    classificationConfidence: Number(classificationConfidence.toFixed(3)),
    geographicReviewStatus,
    geographicConflictReason,
  };
}
