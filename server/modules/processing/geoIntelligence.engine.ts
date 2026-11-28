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
  postalZoneHint: string | null;
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

// Strict street/road/cross/lane tokens — NEVER matches bare ordinals like "1st" (which breaks on "1st Floor"!)
const STREET_TOKEN_RE =
  /(?:\b(?:\d+(?:st|nd|rd|th)\s+)?(?:main\s+road|main\s+rd|cross\s+street|cross\s+st|cross\s+road|cross|street|st|road|rd|lane|ln|avenue|ave|bylane|by-lane|high\s+road|high\s+rd|bypass|ring\s+road|trunk\s+road|salai|salai\s+road)\b|(?:தெரு|சாலை|மெயின்\s*ரோடு|குறுக்கு\s*தெரு|சந்து))/i;

const STREET_SPLIT_TAIL_RE =
  /^(.*?\b(?:main\s+road|main\s+rd|cross\s+street|cross\s+st|cross\s+road|cross|street|st|road|rd|lane|ln|avenue|ave|bylane|by-lane|high\s+road|high\s+rd|bypass|ring\s+road|trunk\s+road|salai(?:\s+road)?)\b(?:\s+(?:phase|stage|sector|part)[\s\-]*[\da-z]+)?)\s+(.+)$/i;

const CROSS_TOKEN_RE = /(?:\bcross(?:\s*(?:st|street|road|rd))?\b|குறுக்கு\s*தெரு)/i;
const ROAD_TOKEN_RE = /(?:\b(?:road|rd|main\s+road|main\s+rd|high\s+road|high\s+rd|salai|bypass|avenue|ave)\b|சாலை|ரோடு)/i;
const LANE_TOKEN_RE = /(?:\b(?:lane|ln|bylane|by-lane)\b|சந்து)/i;

// Urban localities + South Indian / Indian town & village suffixes
const LOCALITY_TOKEN_RE =
  /(?:\b(?:nagar|colony|layout|extension|extn|enclave|gardens|garden|puram|pudur|palayam|estate|industrial\s+estate|residency|township|camp|city|vihar|kunj|park|hills|view|kovil|koil|mandapam|sabha|cantonment)\b|\b[a-z]{3,}(?:patti|patty|kudi|kudy|kkudi|kurichi|kurichy|mangalam|managalam|kulam|samuthiram|samudram|pettai|cheri|chery|halli|thopu|thoppu|medu|kuppam|karai|malai|giri|wadi|puram|pura|oor|ur)\b|\b(?:thennur|tennur|woraiyur|uraiyur|srirangam|thiruverumbur|tiruverumbur|thiruverambur|ariyamangalam|thillai\s*nagar|anna\s*nagar|kk\s*nagar|k\.?\s*k\.?\s*nagar|keelakarai|ayyampatti)\b|(?:நகர்|காலனி|புதூர்|பாளையம்|லேஅவுட்|பட்டி|குடி|குறிச்சி|மங்கலம்|கோவில்))/i;

const URBAN_CORRIDOR_RE =
  /\b(?:thennur|tennur|woraiyur|uraiyur|srirangam|cantonment|ariyamangalam|thiruverumbur|tiruverumbur|thiruverambur)\b/i;

const SUB_ENCLAVE_NOISE_RE =
  /\b(?:apartments?|apts?|flats?|towers?|heights?|residency|house|building|complex|arcade|plaza|mansion|villa|villas)\b/i;

const FLOOR_UNIT_SEGMENT_RE =
  /^(?:(?:\d+(?:st|nd|rd|th)|ground|gr\.?|first|second|third|fourth|top|basement|mezzanine)\s*floor|f[\s.\-]*no[\s.\-:]*[\da-z\/-]+|p[\s.\-]*no[\s.\-:]*[\da-z\/-]+|flat[\s.\-]*(?:no\.?)?[\s.\-:]*[\da-z\/-]+|block[\s.\-]*[a-z0-9]+|(?:phase|stage|sector|part)[\s.\-:]*[\da-z]+|inside|near\b.*|opp\.?\b.*|behind\b.*)$/i;

const LEADING_FLOOR_IN_SEG_RE =
  /^(?:(?:\d+(?:st|nd|rd|th)|ground|gr\.?|first|second|third|fourth|top)\s*floor|f[\s.\-]*no[\s.\-:]*[\da-z\/-]+|p[\s.\-]*no[\s.\-:]*[\da-z\/-]+|flat[\s.\-]*(?:no\.?)?[\s.\-:]*[\da-z\/-]+)\s*[,:\-]?\s*/i;

const DOOR_NO_PREFIX_RE =
  /^(?:(?:d[\s.\-]*no\.?|door[\s.\-]*no\.?|house[\s.\-]*no\.?|h[\s.\-]*no\.?|flat[\s.\-]*no\.?|f[\s.\-]*no\.?|plot[\s.\-]*no\.?|p[\s.\-]*no\.?|plot|flat|apt|no\.?)\s*[:;\-]?\s*[\da-z\/-]+(?:\s*[,;\-]\s*|\s+))|^(?:\d{1,5}(?:[\/\-][a-z\d]{1,6})?\s*[,;]\s*)|^(?:\d{1,5}\s*-\s*[a-z]{1,3}\s*[,;]\s*)/i;

const TRAILING_CITY_ZONE_RE =
  /^(.*?)(?:[\s.,]+|^)(trichy|tiruchirappalli|thiruchirappalli|madurai|chennai|coimbatore|salem|erode|thanjavur|vellore|tirunelveli|thoothukudi|nagercoil|bengaluru|bangalore|hyderabad|mumbai|pune)(?:\s*[-–]\s*0*(\d{1,3}))?\.?$/i;

const CITY_OR_STATE_STOP_RE =
  /^(?:india|tn|tamil\s*nadu|tamilnadu|ka|karnataka|kl|kerala|ap|andhra\s*pradesh|ts|telangana|mh|maharashtra|dl|delhi|wb|west\s*bengal|madurai|chennai|coimbatore|tirunelveli|salem|trichy|tiruchirappalli|thiruchirappalli|erode|thanjavur|vellore|thoothukudi|nagercoil|bengaluru|bangalore|hyderabad|mumbai|pune|kochi|kolkata)$/i;

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
  'floor',
  'building',
  'apartments',
  'apartment',
  'post',
  'inside',
  'near',
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

  const normalized = cleaned
    .replace(/^[\-:;|,.]+|[\-:;|,.]+$/g, '')
    .replace(/\s*-\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return null;

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
  if (LOCALITY_TOKEN_RE.test(label) && !CROSS_TOKEN_RE.test(label) && !STREET_TOKEN_RE.test(label)) {
    if (/(?:\bcolony\b|காலனி)/i.test(label)) return 'COLONY';
    if (/(?:\blayout\b|லேஅவுட்)/i.test(label)) return 'LAYOUT';
    if (/(?:\bnagar\b|நகர்)/i.test(label)) return 'NAGAR_LOCALITY';
    return 'SUB_AREA';
  }
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

  const parsedAddr = parseAddressHierarchy(addressText);
  const candidateAddrPhrase = parsedAddr.subArea || parsedAddr.street || parsedAddr.locality;
  if (!candidateAddrPhrase && !STREET_TOKEN_RE.test(addressText) && !LOCALITY_TOKEN_RE.test(addressText)) {
    return 'INSUFFICIENT';
  }

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
    const headingNorm = (normalizeForMatch(headingText) || '').replace(/\b(\d+)(?:st|nd|rd|th)\b/g, '$1');
    const addrNorm = (normalizeForMatch(candidateAddrPhrase || addressText) || '').replace(/\b(\d+)(?:st|nd|rd|th)\b/g, '$1');
    if (headingNorm === addrNorm || addrNorm.includes(headingNorm) || headingNorm.includes(addrNorm)) {
      return 'MATCH';
    }
    if (overlap.length >= Math.ceil(headingTokens.length * 0.5)) {
      return 'MATCH';
    }
  }

  // Phonetic stem fallback (e.g. Kuvalakudi vs Kavalakudi, Thiruvebur vs Thiruverumbur)
  const headingPhonetic = headingTokens.map(phoneticPlaceWord);
  const addrPhonetic = new Set(addrTokens.map(phoneticPlaceWord));
  if (headingPhonetic.some((hp) => hp.length >= 4 && addrPhonetic.has(hp))) {
    return 'MATCH';
  }

  return 'CONFLICT';
}

/**
 * Computes a phonetic skeleton for Indian/Tamil-English place names so common transliteration
 * spelling differences (e.g. Kuvalakkudi/Kuvalakudy/Kavalakudi, Arasina Kudi/Arasangudi,
 * Panayakurichy/Panayakurichi, Thiruverumbur/Tiruverambur/Thiruvebur, Kovil/Koil) cluster cleanly.
 */
export function phoneticPlaceWord(rawWord: string): string {
  let w = rawWord
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^a-z0-9\u0B80-\u0BFF]/g, '');
  if (!w) return '';
  if (/^\d+$/.test(w)) return w;
  if (/[^\u0000-\u007F]/.test(w)) return w;

  w = w
    .replace(/th/g, 't')
    .replace(/dh/g, 'd')
    .replace(/bh/g, 'b')
    .replace(/ph/g, 'f')
    .replace(/sh/g, 's')
    .replace(/zh/g, 'l')
    .replace(/y+$/g, 'i')
    .replace(/kovil|koil/g, 'kovil')
    .replace(/managalam/g, 'mangalam')
    .replace(/([a-z])\1+/g, '$1');

  return w;
}

export function buildPlaceClusterSignature(label: string): string {
  const words = (normalizeForMatch(label) || '')
    .split(' ')
    .filter((w) => w && !GENERIC_GEO_WORDS.has(w))
    .map(phoneticPlaceWord)
    .filter(Boolean);
  return words.join(' ');
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 3) return 99;
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : Math.min(prev, dp[j], dp[j - 1]) + 1;
      prev = tmp;
    }
  }
  return dp[b.length];
}

/**
 * Tests whether two place labels represent obvious transliteration/spelling variants of the SAME place
 * (never merges different numbers like Cross 4 vs Cross 5 or Phase 1 vs Phase 2).
 */
export function arePlaceSpellingVariants(a: string, b: string): boolean {
  const normA = normalizeGeoGroupKey(a);
  const normB = normalizeGeoGroupKey(b);
  if (!normA || !normB) return false;
  if (normA === normB) return true;

  const numsA = extractNumberTokens(normA).join(',');
  const numsB = extractNumberTokens(normB).join(',');
  if (numsA !== numsB) return false;

  const sigA = buildPlaceClusterSignature(a);
  const sigB = buildPlaceClusterSignature(b);
  if (!sigA || !sigB) return false;
  if (sigA === sigB) return true;

  // Compact space-collapsed phonetic check (e.g. "ariyamangalam" vs "ariya mangalam" vs "ariyamanagalam",
  // "arasinakudi" vs "arasangudi", "kuvalakudi" vs "kavalakudi")
  const compA = sigA.replace(/\s+/g, '');
  const compB = sigB.replace(/\s+/g, '');
  if (compA === compB) return true;

  // Consonant skeleton check for long Indian place names (>= 7 chars)
  const skel = (s: string) => s.replace(/[aeiou]/g, '');
  if (compA.length >= 7 && compB.length >= 7) {
    const d = levenshtein(compA, compB);
    if (d <= 1) return true;
    const skA = skel(compA);
    const skB = skel(compB);
    if (skA.length >= 5 && skB.length >= 5 && (skA === skB || levenshtein(skA, skB) <= 1) && d <= 3) {
      return true;
    }
  }

  return false;
}

function stripBuildingPrefix(seg: string): string {
  // e.g. "SS APARTMENTS GNANAM COLONY" -> "GNANAM COLONY", "MR HOUSE" -> ""
  const m = seg.match(
    /^([a-z0-9.\s&-]{1,28}\b(?:apartments?|apts?|flats?|towers?|heights?|residency|house|building|complex))\b\s*[,:\-]?\s*(.*)$/i
  );
  if (!m) return seg;
  const tail = m[2].trim();
  if (tail && tail.length >= 3) {
    return tail;
  }
  return '';
}

function stripKnownAreaSuffix(seg: string, areaTokens: Set<string>): string {
  if (areaTokens.size === 0) return seg;
  const words = seg.trim().split(/\s+/).filter(Boolean);
  while (words.length > 1) {
    const lastPhonetic = phoneticPlaceWord(words[words.length - 1]);
    if (areaTokens.has(lastPhonetic)) {
      words.pop();
    } else {
      break;
    }
  }
  return words.join(' ').trim();
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
      postalZoneHint: null,
      streetGroup: 'UNIDENTIFIED',
      groupType: 'UNIDENTIFIED',
      confidence: 0,
      evidenceTokens: [],
    };
  }

  let working = originalAddress.normalize('NFC').replace(/\s+/g, ' ').trim();
  let pinCode: string | null = null;
  let postalZoneHint: string | null = null;

  const pinMatch = working.match(/\b([1-9]\d{5})\b/);
  if (pinMatch) {
    pinCode = pinMatch[1];
    postalZoneHint = String(Number(pinCode.slice(-3)));
    working = working.replace(pinMatch[0], ' ').replace(/\s*,\s*$/, '').trim();
  }

  let doorOrHouseNo: string | null = null;
  const doorPrefixMatch = working.match(DOOR_NO_PREFIX_RE);
  if (doorPrefixMatch) {
    doorOrHouseNo = doorPrefixMatch[0].replace(/[,;\s]+$/, '').trim();
    working = working.slice(doorPrefixMatch[0].length).trim();
  }

  // Split by comma/semicolon/newline, and ALSO strip trailing city+zone from each segment
  const rawSegments = working
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  let city: string | null = null;
  let state: string | null = null;
  const expandedSegments: string[] = [];

  for (let i = 0; i < rawSegments.length; i++) {
    let seg = rawSegments[i].replace(/\.+$/, '').trim();
    if (!seg) continue;

    // Leading house/plot/door prefix inside first segment
    if (i === 0) {
      const m = seg.match(
        /^(?:(?:no\.?|d\.?\s*no\.?|door\s*no\.?|p\.?\s*no\.?|plot\s*no\.?|plot|flat|f\.?\s*no\.?)\s*[:;\-]?\s*[\da-z\/-]+(?:\s+[\da-z\/-]+)?\s+|\d{1,5}[\/\-]?[a-z]?\s+)/i
      );
      if (m && seg.length > m[0].length + 2) {
        if (!doorOrHouseNo) doorOrHouseNo = m[0].trim();
        seg = seg.slice(m[0].length).trim();
      }
    }

    // Remove embedded floor/flat prefix (e.g. "1ST FLOOR", "3RD FLOOR", "F-NO-20")
    seg = seg.replace(LEADING_FLOOR_IN_SEG_RE, '').trim();
    if (!seg || FLOOR_UNIT_SEGMENT_RE.test(seg)) continue;

    // Extract city/state and postal zone suffixes like "THILLAI NAGAR. TRICHY- 18" or "THENNUR TRICHY-17"
    const cityZoneMatch = seg.match(TRAILING_CITY_ZONE_RE);
    if (cityZoneMatch) {
      const prefix = cityZoneMatch[1].replace(/[.,]+$/, '').trim();
      const cityRaw = cityZoneMatch[2];
      const zoneNum = cityZoneMatch[3];
      if (!city) city = smartTitleCase(cityRaw);
      if (zoneNum && !postalZoneHint) {
        postalZoneHint = String(Number(zoneNum));
      }
      seg = prefix;
      if (!seg) continue;
    } else {
      const cleanSeg = seg.replace(/\./g, '').trim();
      if (i >= rawSegments.length - 2 && CITY_OR_STATE_STOP_RE.test(cleanSeg)) {
        if (
          /^(?:tn|tamil\s*nadu|tamilnadu|ka|karnataka|kl|kerala|ap|andhra\s*pradesh|ts|telangana|mh|maharashtra|dl|delhi|wb|west\s*bengal|india)$/i.test(
            cleanSeg
          )
        ) {
          state = smartTitleCase(cleanSeg);
        } else {
          city = smartTitleCase(cleanSeg);
        }
        continue;
      }
    }

    // Strip pure building/apartment prefix when followed by an actual locality (e.g. "SS APARTMENTS GNANAM COLONY")
    if (SUB_ENCLAVE_NOISE_RE.test(seg)) {
      const strippedBuilding = stripBuildingPrefix(seg);
      if (!strippedBuilding) continue;
      seg = strippedBuilding;
    }

    // Split comma-less compound segments at the street keyword boundary:
    // e.g. "MARIYAMMAN KOVIL STREET KUVALAKUDI ARIYAMANGALAM" -> ["MARIYAMMAN KOVIL STREET", "KUVALAKUDI ARIYAMANGALAM"]
    const tailSplit = seg.match(STREET_SPLIT_TAIL_RE);
    if (tailSplit && tailSplit[1] && tailSplit[2] && !/^\d+$/.test(tailSplit[2].trim())) {
      expandedSegments.push(tailSplit[1].trim());
      expandedSegments.push(tailSplit[2].trim());
    } else {
      expandedSegments.push(seg);
    }
  }

  let street: string | null = null;
  const orderedPlaceCandidates: Array<{ label: string; hasLocalityCue: boolean }> = [];
  const evidenceTokens: string[] = [];

  for (let idx = 0; idx < expandedSegments.length; idx++) {
    const seg = expandedSegments[idx].trim();
    // Skip empty, pure door/plot/survey numbers (e.g. "5/97", "3-B"), and floor/unit labels
    if (!seg || !/[a-z\u0B80-\u0BFF]{3,}/i.test(seg) || FLOOR_UNIT_SEGMENT_RE.test(seg)) continue;

    // A segment matching STREET_TOKEN_RE (e.g. "Kavimani Street", "4th Street", "7th Cross", "Ritz Avenue Phase-2")
    if (STREET_TOKEN_RE.test(seg) && !LOCALITY_TOKEN_RE.test(seg)) {
      if (!street) {
        street = canonicalizeGeoLabel(seg);
        evidenceTokens.push(seg);
      }
      continue;
    }

    // If BOTH street and locality tokens exist in one segment (e.g. "Mariyamman Kovil Street")
    if (STREET_TOKEN_RE.test(seg)) {
      if (!street) {
        street = canonicalizeGeoLabel(seg);
        evidenceTokens.push(seg);
      }
      continue;
    }

    // Locality / Village / Sub-Area candidate
    if (LOCALITY_TOKEN_RE.test(seg)) {
      const label = canonicalizeGeoLabel(seg);
      if (label) {
        orderedPlaceCandidates.push({ label, hasLocalityCue: true });
        evidenceTokens.push(seg);
      }
      continue;
    }

    // Non-street descriptive segment (trailing place name or mid-segment locality)
    if (seg.length >= 3) {
      const label = canonicalizeGeoLabel(seg);
      if (label) {
        orderedPlaceCandidates.push({ label, hasLocalityCue: false });
      }
    }
  }

  const hasKnownCueOrStreet = Boolean(street) || orderedPlaceCandidates.some((c) => c.hasLocalityCue) || expandedSegments.length >= 2;
  const allPlaceCandidates = orderedPlaceCandidates
    .filter((c) => c.hasLocalityCue || hasKnownCueOrStreet)
    .map((c) => c.label);

  // Separate Area-level / corridor tail from primary Place/Locality
  let subArea: string | null = null;
  let areaFromAddress: string | null = null;

  if (allPlaceCandidates.length === 1) {
    // Handle comma-less 2-word village+area like "Thondamanpatti Tiruverambur" or "Kuvalakudi Ariyamangalam"
    const words = allPlaceCandidates[0].split(/\s+/).filter(Boolean);
    if (words.length === 2 && LOCALITY_TOKEN_RE.test(words[0]) && LOCALITY_TOKEN_RE.test(words[1])) {
      subArea = words[0];
      areaFromAddress = words[1];
    } else if (words.length >= 3 && LOCALITY_TOKEN_RE.test(words[words.length - 1]) && LOCALITY_TOKEN_RE.test(words[0])) {
      // Check if last word is a broader area/corridor (e.g. "Kuvalakudi Ariyamangalam")
      if (URBAN_CORRIDOR_RE.test(words[words.length - 1])) {
        subArea = words.slice(0, words.length - 1).join(' ');
        areaFromAddress = words[words.length - 1];
      } else {
        subArea = allPlaceCandidates[0];
      }
    } else {
      subArea = allPlaceCandidates[0];
    }
  } else if (allPlaceCandidates.length >= 2) {
    // Decide which locality is the primary Place group vs sub-enclave / parent Area:
    // Pattern A: [SubColony, MainNeighborhood] e.g. ["Annamalaipuram", "Thennur"], ["Gnanam Colony", "Ramalinga Nagar"]
    // Pattern B: [SpecificVillage, BroaderTaluk/Area] e.g. ["Selva Mariamman Kovil", "Woraiyur"], ["Kuvalakudi", "Ariyamangalam"]
    // Pattern C: [PanchayatHub, SpecificVillage, Area] e.g. ["Thondamanpatti", "Arasangudi", "Tiruverumbur"]
    const first = allPlaceCandidates[0];
    const last = allPlaceCandidates[allPlaceCandidates.length - 1];
    if (allPlaceCandidates.length === 2 && URBAN_CORRIDOR_RE.test(last) && !URBAN_CORRIDOR_RE.test(first)) {
      // e.g. ["Annamalaipuram", "Thennur"] or ["Selva Mariamman Kovil", "Woraiyur"] or ["Kuvalakudi", "Ariyamangalam"]
      if (/\b(?:thennur|tennur|ramalinga\s*nagar|anna\s*nagar|thillai\s*nagar)\b/i.test(last)) {
        subArea = last;
        if (!street) street = first;
      } else {
        subArea = first;
        areaFromAddress = last;
      }
    } else if (allPlaceCandidates.length >= 3) {
      subArea = allPlaceCandidates[allPlaceCandidates.length - 2];
      areaFromAddress = last;
    } else {
      // Both rural/locality names, e.g. ["Thondamanpatti", "Arasangudi"] or ["Kuvalakudi", "Ariyamangalam"]
      if (URBAN_CORRIDOR_RE.test(last)) {
        subArea = first;
        areaFromAddress = last;
      } else {
        subArea = last;
        areaFromAddress = first;
      }
    }
  }

  // PLACE-FIRST GROUPING: Categorize by Place / Sub-Area / Locality instead of Cross or Floor/Street!
  // Only fall back to street if no subArea exists.
  const primaryGroup = subArea || street || 'UNIDENTIFIED';
  const groupType: GeoGroupType =
    primaryGroup === 'UNIDENTIFIED' ? 'UNIDENTIFIED' : inferGroupType(primaryGroup);

  let confidence = 0.25;
  if (subArea && street) confidence = 0.94;
  else if (subArea) confidence = 0.89;
  else if (street) confidence = 0.85;

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
    postalZoneHint,
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

  // 1. Area Identification
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

  // Build parent-area phonetic tokens so we never let the parent Area swallow the sub-area
  const areaPhoneticTokens = new Set(
    (extractSignificantTokens(area) || []).map(phoneticPlaceWord).filter(Boolean)
  );

  // 2. SubArea / Place / Locality
  let subArea =
    canonicalizeGeoLabel(params.explicitSubArea) ||
    parsedAddr.subArea ||
    (params.aiSuggestion?.suggestedSubArea &&
    params.rawAddress?.toLowerCase().includes(params.aiSuggestion.suggestedSubArea.toLowerCase())
      ? canonicalizeGeoLabel(params.aiSuggestion.suggestedSubArea)
      : null);

  if (subArea && areaPhoneticTokens.size > 0) {
    const stripped = stripKnownAreaSuffix(subArea, areaPhoneticTokens);
    if (stripped && stripped.length >= 3) {
      subArea = canonicalizeGeoLabel(stripped) || subArea;
    }
  }

  if (subArea) {
    subArea = applyDictionaryAlias(subArea, 'SUB_AREA', area, dicts) || subArea;
  }

  const subAreaSameAsArea = Boolean(
    area && subArea && (normalizeGeoGroupKey(subArea) === normalizeGeoGroupKey(area) || arePlaceSpellingVariants(subArea, area))
  );

  // 3. Explicit Street vs Parsed Street
  const explicitStreet = canonicalizeGeoLabel(params.explicitStreet);
  let street: string | null = explicitStreet || parsedAddr.street || null;

  // Choose Place-first primary label (Locality/SubArea preferred over Street/Cross when distinct from Area!)
  const placePrimary =
    (!subAreaSameAsArea && subArea) ||
    parsedAddr.areaFromAddress && (!area || !arePlaceSpellingVariants(parsedAddr.areaFromAddress, area))
      ? (!subAreaSameAsArea && subArea ? subArea : parsedAddr.areaFromAddress)
      : null;

  const addressPrimary = placePrimary || street || subArea || null;
  const cleanHeading = params.activeSectionHeading
    ? canonicalizeGeoLabel(stripHeadingPrefix(params.activeSectionHeading))
    : null;

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
      streetGroup = placePrimary || cleanHeading;
      if (!street) street = cleanHeading;
      groupType = inferGroupType(streetGroup);
      classificationSource = 'SECTION_AND_ADDRESS';
      classificationConfidence = 0.96;
      geographicReviewStatus = 'CONFIRMED';
    } else if (cmp === 'CONFLICT') {
      streetGroup = addressPrimary || 'UNIDENTIFIED';
      groupType = inferGroupType(streetGroup);
      classificationSource = 'ADDRESS_CONFLICT_DETECTED';
      classificationConfidence = 0.65;
      geographicReviewStatus = 'CONFLICT';
      geographicConflictReason = `Address specifies "${addressPrimary || cmpText}" which conflicts with active section heading "${cleanHeading}".`;
    } else {
      streetGroup = cleanHeading;
      if (!street) street = null;
      groupType = inferGroupType(streetGroup);
      classificationSource = 'SECTION_CONTEXT';
      classificationConfidence = 0.72;
      geographicReviewStatus = 'NEEDS_REVIEW';
      geographicConflictReason = `Address lacks explicit street/locality tokens; provisionally grouped under section heading "${cleanHeading}" for human review.`;
    }
  } else {
    if (placePrimary) {
      streetGroup = placePrimary;
      groupType = inferGroupType(streetGroup);
      classificationSource = parsedAddr.subArea ? 'RULE_ADDRESS_PLACE' : 'EXPLICIT_SUBAREA';
      classificationConfidence = Math.max(0.88, parsedAddr.confidence);
      geographicReviewStatus = 'AUTO';
    } else if (explicitStreet) {
      street = explicitStreet;
      streetGroup = explicitStreet;
      groupType = inferGroupType(streetGroup);
      classificationSource = 'EXPLICIT_COLUMN';
      classificationConfidence = 0.94;
      geographicReviewStatus = 'CONFIRMED';
    } else if (parsedAddr.streetGroup !== 'UNIDENTIFIED') {
      streetGroup = parsedAddr.street || parsedAddr.streetGroup;
      groupType = inferGroupType(streetGroup);
      classificationSource = 'RULE_ADDRESS';
      classificationConfidence = parsedAddr.confidence;
      geographicReviewStatus = parsedAddr.confidence >= 0.85 ? 'AUTO' : 'NEEDS_REVIEW';
    } else if (params.aiSuggestion && params.rawAddress) {
      const candidateAi =
        params.aiSuggestion.suggestedSubArea || params.aiSuggestion.suggestedStreet || null;
      const ev = (params.aiSuggestion.evidence || candidateAi || '').toLowerCase();
      if (candidateAi && ev && params.rawAddress.toLowerCase().includes(ev)) {
        const aiPlace = canonicalizeGeoLabel(candidateAi);
        if (aiPlace) {
          if (!subArea && params.aiSuggestion.suggestedSubArea) subArea = canonicalizeGeoLabel(params.aiSuggestion.suggestedSubArea);
          if (!street && params.aiSuggestion.suggestedStreet) street = canonicalizeGeoLabel(params.aiSuggestion.suggestedStreet);
          streetGroup = aiPlace;
          groupType =
            (params.aiSuggestion.groupType as GeoGroupType) || inferGroupType(aiPlace);
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

  if (streetGroup !== 'UNIDENTIFIED') {
    const aliasedPlace =
      applyDictionaryAlias(streetGroup, 'SUB_AREA', area, dicts) ||
      applyDictionaryAlias(streetGroup, 'STREET', area, dicts);
    if (aliasedPlace && aliasedPlace !== streetGroup) {
      streetGroup = aliasedPlace;
      if (classificationSource.startsWith('RULE_')) classificationSource = 'DICTIONARY_ALIAS';
    }
  } else {
    geographicReviewStatus = 'UNIDENTIFIED';
    if (!geographicConflictReason) {
      geographicConflictReason =
        'No place, locality, or street could be reliably identified from the source address.';
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
    classificationSource:
      areaSource && classificationSource === 'UNIDENTIFIED'
        ? `${areaSource}+UNIDENTIFIED`
        : classificationSource,
    classificationConfidence: Number(classificationConfidence.toFixed(3)),
    geographicReviewStatus,
    geographicConflictReason,
  };
}

// ============================================================================
// NEAREST-PLACE GEOGRAPHIC ROUTE SEQUENCING & FIELD-WALK DOOR SORTING
// ============================================================================

export interface ProximityGroupInput<T> {
  key: string;
  displayName: string;
  isUnidentified?: boolean;
  rows: T[];
}

export interface ProximityRecordSignals {
  pin_code?: string | null;
  street?: string | null;
  sub_area?: string | null;
  locality?: string | null;
  area?: string | null;
  city?: string | null;
  original_row_number?: number | null;
  row_number?: number;
  raw_data?: Record<string, string> | null;
  raw_text?: string | null;
}

function extractRecordRawAddressText(r: ProximityRecordSignals): string {
  if (r.raw_text) return r.raw_text;
  const raw = r.raw_data || {};
  const parts: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    if (/(addr|address|loc|street|area|place|city|pin)/i.test(k) && v) {
      parts.push(String(v));
    }
  }
  if (parts.length === 0) {
    parts.push(...Object.values(raw).filter((v) => typeof v === 'string' && v.trim().length > 2));
  }
  if (r.street) parts.push(r.street);
  if (r.sub_area) parts.push(r.sub_area);
  if (r.city) parts.push(r.city);
  if (r.pin_code) parts.push(r.pin_code);
  return parts.join(', ');
}

interface GroupSpatialProfile {
  idx: number;
  key: string;
  displayName: string;
  pins: Set<string>;
  zones: Set<number>;
  placeTokens: Set<string>;
  streetTokens: Set<string>;
  medianRow: number;
  size: number;
}

function buildSpatialProfile<T extends ProximityRecordSignals>(
  idx: number,
  g: ProximityGroupInput<T>
): GroupSpatialProfile {
  const pins = new Set<string>();
  const zones = new Set<number>();
  const placeTokens = new Set<string>();
  const streetTokens = new Set<string>();
  const rowNums: number[] = [];

  for (const t of extractSignificantTokens(g.displayName)) {
    placeTokens.add(phoneticPlaceWord(t));
  }

  for (const r of g.rows) {
    const rn = Number(r.original_row_number || r.row_number || 0);
    if (rn > 0) rowNums.push(rn);

    if (r.pin_code && /^[1-9]\d{5}$/.test(r.pin_code.trim())) {
      const p = r.pin_code.trim();
      pins.add(p);
      zones.add(Number(p.slice(-3)));
    }

    const rawText = extractRecordRawAddressText(r);
    const parsed = parseAddressHierarchy(rawText);
    if (parsed.pinCode) {
      pins.add(parsed.pinCode);
      zones.add(Number(parsed.pinCode.slice(-3)));
    }
    if (parsed.postalZoneHint && /^\d+$/.test(parsed.postalZoneHint)) {
      zones.add(Number(parsed.postalZoneHint));
    }
    // Also check any "city - 18" pattern directly in rawText
    const zoneMatches = rawText.matchAll(/\b(?:trichy|tiruchirappalli|madurai|chennai|coimbatore|salem)\s*[-–]\s*0*(\d{1,3})\b/gi);
    for (const zm of zoneMatches) {
      zones.add(Number(zm[1]));
    }

    for (const t of extractSignificantTokens([parsed.subArea, parsed.areaFromAddress, r.sub_area, r.locality].filter(Boolean).join(' '))) {
      const ph = phoneticPlaceWord(t);
      if (ph.length >= 3) placeTokens.add(ph);
    }
    for (const t of extractSignificantTokens(rawText)) {
      const ph = phoneticPlaceWord(t);
      if (ph.length >= 4 && !/^\d+$/.test(ph)) {
        placeTokens.add(ph);
      }
    }
    for (const st of extractSignificantTokens(r.street || parsed.street)) {
      const ph = phoneticPlaceWord(st);
      if (ph.length >= 3) streetTokens.add(ph);
    }
  }

  rowNums.sort((a, b) => a - b);
  const medianRow = rowNums.length > 0 ? rowNums[Math.floor(rowNums.length / 2)] : idx;

  return {
    idx,
    key: g.key,
    displayName: g.displayName,
    pins,
    zones,
    placeTokens,
    streetTokens,
    medianRow,
    size: g.rows.length,
  };
}

function computeProximityAffinity(
  a: GroupSpatialProfile,
  b: GroupSpatialProfile,
  aiRankMap?: Map<string, number>
): number {
  let score = 0;

  // 1. Direct containment (e.g. rows of "Arasangudi" mention "Thondamanpatti", or "Ritz Avenue" mentions "Kuvalakudi")
  const aNameTokens = extractSignificantTokens(a.displayName).map(phoneticPlaceWord).filter((t) => t.length >= 3);
  const bNameTokens = extractSignificantTokens(b.displayName).map(phoneticPlaceWord).filter((t) => t.length >= 3);

  const aMentionsB = bNameTokens.length > 0 && bNameTokens.every((t) => a.placeTokens.has(t));
  const bMentionsA = aNameTokens.length > 0 && aNameTokens.every((t) => b.placeTokens.has(t));
  if (aMentionsB || bMentionsA) {
    score += 75;
  }

  // 2. Shared place / locality context tokens (e.g. Thennur <-> Tennur Anna Nagar; Kuvalakudi <-> Ariyamangalam)
  let sharedPlace = 0;
  for (const tok of a.placeTokens) {
    if (b.placeTokens.has(tok)) sharedPlace++;
  }
  score += Math.min(60, sharedPlace * 22);

  // 3. Exact 6-digit PIN match + numeric PIN/postal zone distance (e.g. Trichy-17 <-> Trichy-18 <-> Trichy-3)
  let sharedPin = false;
  for (const p of a.pins) {
    if (b.pins.has(p)) {
      sharedPin = true;
      break;
    }
  }
  if (sharedPin) score += 28;

  if (a.zones.size > 0 && b.zones.size > 0) {
    let minZoneDiff = Infinity;
    for (const za of a.zones) {
      for (const zb of b.zones) {
        const d = Math.abs(za - zb);
        if (d < minZoneDiff) minZoneDiff = d;
      }
    }
    if (minZoneDiff === 0) {
      score += 42;
    } else if (minZoneDiff <= 3) {
      score += 24 / (1 + minZoneDiff);
    } else if (minZoneDiff <= 10) {
      score += 10 / (1 + minZoneDiff * 0.5);
    }
  }

  // 4. Shared street corridor (e.g. Mariyamman Kovil Street passing through Surakudipatti -> Kuvalakudi -> Panayakurichi)
  let sharedStreet = 0;
  for (const st of a.streetTokens) {
    if (b.streetTokens.has(st)) sharedStreet++;
  }
  score += Math.min(24, sharedStreet * 12);

  // 5. Optional AI nearest-neighbor travel sequence affinity
  if (aiRankMap) {
    const ra = aiRankMap.get(a.key);
    const rb = aiRankMap.get(b.key);
    if (ra !== undefined && rb !== undefined) {
      const stepDiff = Math.abs(ra - rb);
      if (stepDiff === 1) score += 85;
      else if (stepDiff === 2) score += 35;
      else if (stepDiff <= 4) score += 12;
    }
  }

  return score;
}

/**
 * Merges minor spelling/transliteration variants of the SAME place within an Area
 * (e.g. "Kuvalakkudi", "Kuvalakudy", "Kavalakudi" -> "Kuvalakudi"), choosing the most frequent display spelling.
 */
export function mergeVariantGeoGroups<T>(
  groups: ProximityGroupInput<T>[]
): ProximityGroupInput<T>[] {
  const unidentified: ProximityGroupInput<T>[] = [];
  const normal: ProximityGroupInput<T>[] = [];

  for (const g of groups) {
    if (g.isUnidentified || g.key === '__UNIDENTIFIED__' || g.displayName.toUpperCase() === 'UNIDENTIFIED') {
      unidentified.push(g);
    } else {
      normal.push(g);
    }
  }

  const merged: Array<ProximityGroupInput<T> & { variantCounts: Map<string, number> }> = [];
  for (const g of normal) {
    const match = merged.find((m) => arePlaceSpellingVariants(m.displayName, g.displayName));
    if (match) {
      match.rows.push(...g.rows);
      match.variantCounts.set(
        g.displayName,
        (match.variantCounts.get(g.displayName) || 0) + g.rows.length
      );
      // Pick the spelling with the highest customer row count
      let bestLabel = match.displayName;
      let bestCount = -1;
      for (const [lbl, cnt] of match.variantCounts.entries()) {
        if (cnt > bestCount) {
          bestCount = cnt;
          bestLabel = lbl;
        }
      }
      match.displayName = bestLabel;
    } else {
      const vc = new Map<string, number>();
      vc.set(g.displayName, g.rows.length);
      merged.push({
        key: g.key,
        displayName: g.displayName,
        isUnidentified: false,
        rows: [...g.rows],
        variantCounts: vc,
      });
    }
  }

  const out: ProximityGroupInput<T>[] = merged.map(({ key, displayName, isUnidentified, rows }) => ({
    key,
    displayName,
    isUnidentified,
    rows,
  }));

  if (unidentified.length > 0) {
    const combinedUnid: ProximityGroupInput<T> = {
      key: '__UNIDENTIFIED__',
      displayName: 'UNIDENTIFIED',
      isUnidentified: true,
      rows: [],
    };
    for (const u of unidentified) combinedUnid.rows.push(...u.rows);
    out.push(combinedUnid);
  }

  return out;
}

/**
 * Orders Place / Locality groups (or Areas) as a continuous nearest-neighbor geographic route
 * so field staff visit adjacent places one by one without backtracking, keeping UNIDENTIFIED last.
 * When `entryReference` is passed (e.g., the last visited street of the previous Area),
 * the tour is anchored to enter at the nearest street/locality to `entryReference`.
 */
export function orderGeoGroupsByProximity<T extends ProximityRecordSignals>(
  groups: ProximityGroupInput<T>[],
  options?: {
    aiOrderedKeys?: string[] | null;
    entryReference?: { label?: string | null; rows: T[] } | null;
  }
): ProximityGroupInput<T>[] {
  if (groups.length <= 1) return groups;

  const unidentified: ProximityGroupInput<T>[] = [];
  const candidates: ProximityGroupInput<T>[] = [];
  for (const g of groups) {
    if (g.isUnidentified || g.key === '__UNIDENTIFIED__' || g.displayName.toUpperCase() === 'UNIDENTIFIED') {
      unidentified.push(g);
    } else {
      candidates.push(g);
    }
  }

  const entryProfile =
    options?.entryReference && options.entryReference.rows.length > 0
      ? buildSpatialProfile(-1, {
          key: '__ENTRY_REF__',
          displayName: options.entryReference.label || '',
          rows: options.entryReference.rows,
        })
      : null;

  if (candidates.length <= 2) {
    if (candidates.length === 2) {
      if (entryProfile) {
        const p0 = buildSpatialProfile(0, candidates[0]);
        const p1 = buildSpatialProfile(1, candidates[1]);
        const a0 = computeProximityAffinity(entryProfile, p0);
        const a1 = computeProximityAffinity(entryProfile, p1);
        if (Math.abs(a1 - a0) > 0.01) {
          return a1 > a0 ? [candidates[1], candidates[0], ...unidentified] : [candidates[0], candidates[1], ...unidentified];
        }
      }
      candidates.sort((a, b) => {
        const minA = Math.min(...a.rows.map((r) => Number(r.original_row_number || r.row_number || 0)).filter(Boolean), 999999);
        const minB = Math.min(...b.rows.map((r) => Number(r.original_row_number || r.row_number || 0)).filter(Boolean), 999999);
        return minA !== minB ? minA - minB : naturalGeoCompare(a.displayName, b.displayName);
      });
    }
    return [...candidates, ...unidentified];
  }

  const aiRankMap = new Map<string, number>();
  if (options?.aiOrderedKeys && options.aiOrderedKeys.length > 0) {
    let keys = [...options.aiOrderedKeys];
    if (entryProfile && keys.length >= 2) {
      // Orient AI path forward or reversed so entry end is closest to previous Area's exit
      const firstCand = candidates.find(
        (c) => c.key === keys[0] || normalizeGeoGroupKey(c.key) === normalizeGeoGroupKey(keys[0])
      );
      const lastCand = candidates.find(
        (c) =>
          c.key === keys[keys.length - 1] ||
          normalizeGeoGroupKey(c.key) === normalizeGeoGroupKey(keys[keys.length - 1])
      );
      if (firstCand && lastCand) {
        const affFirst = computeProximityAffinity(entryProfile, buildSpatialProfile(0, firstCand));
        const affLast = computeProximityAffinity(entryProfile, buildSpatialProfile(1, lastCand));
        if (affLast > affFirst + 5) {
          keys = keys.reverse();
        }
      }
    }
    keys.forEach((k, idx) => {
      aiRankMap.set(k, idx);
      aiRankMap.set(normalizeGeoGroupKey(k), idx);
    });
  }

  const profiles = candidates.map((g, idx) => buildSpatialProfile(idx, g));
  const n = profiles.length;
  const affinity: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const w = computeProximityAffinity(profiles[i], profiles[j], aiRankMap.size > 0 ? aiRankMap : undefined);
      affinity[i][j] = w;
      affinity[j][i] = w;
    }
  }

  // Pick anchor start:
  // If entryReference is present, start at the group closest to entryReference.
  // Otherwise, honor AI rank 0 or lowest postal zone / highest hub score.
  let startIdx = 0;
  let bestStartScore = -Infinity;
  if (entryProfile) {
    for (let i = 0; i < n; i++) {
      const p = profiles[i];
      const entryAff = computeProximityAffinity(entryProfile, p);
      const aiRank = aiRankMap.get(p.key);
      const aiStartBonus = aiRank === 0 ? 18 : aiRank === 1 ? 8 : 0;
      const totalScore = entryAff + aiStartBonus + Math.min(10, p.size * 0.25);
      if (totalScore > bestStartScore) {
        bestStartScore = totalScore;
        startIdx = i;
      }
    }
  } else {
    for (let i = 0; i < n; i++) {
      const p = profiles[i];
      const aiRank = aiRankMap.get(p.key);
      if (aiRank === 0) {
        startIdx = i;
        break;
      }
      const minZone = p.zones.size > 0 ? Math.min(...Array.from(p.zones)) : 999;
      const totalDegree = affinity[i].reduce((acc, v) => acc + v, 0);
      const score = (minZone < 999 ? (100 - minZone) * 2 : 0) + Math.min(30, p.size) + totalDegree * 0.15;
      if (score > bestStartScore) {
        bestStartScore = score;
        startIdx = i;
      }
    }
  }

  // Greedy Nearest-Neighbor walk over spatial affinity graph
  const visited = new Array<boolean>(n).fill(false);
  const tour: number[] = [startIdx];
  visited[startIdx] = true;

  while (tour.length < n) {
    const curr = tour[tour.length - 1];
    let bestNext = -1;
    let bestWeight = -Infinity;

    for (let j = 0; j < n; j++) {
      if (visited[j]) continue;
      let w = affinity[curr][j];
      if (w === 0) {
        const aiCurr = aiRankMap.get(profiles[curr].key);
        const aiNext = aiRankMap.get(profiles[j].key);
        if (aiCurr !== undefined && aiNext !== undefined) {
          w = -Math.abs(aiNext - aiCurr);
        } else {
          w = -Math.abs(profiles[j].medianRow - profiles[curr].medianRow) * 0.0001;
        }
      }
      if (w > bestWeight) {
        bestWeight = w;
        bestNext = j;
      }
    }

    if (bestNext === -1) break;
    visited[bestNext] = true;
    tour.push(bestNext);
  }

  // 2-opt local path improvement (anchors tour[0] as entry and optimizes rest of path)
  if (n >= 4 && n <= 120) {
    let improved = true;
    let guard = 0;
    while (improved && guard < 40) {
      improved = false;
      guard++;
      for (let i = 0; i < n - 2; i++) {
        for (let k = i + 2; k < n - 1; k++) {
          const before = affinity[tour[i]][tour[i + 1]] + affinity[tour[k]][tour[k + 1]];
          const after = affinity[tour[i]][tour[k]] + affinity[tour[i + 1]][tour[k + 1]];
          if (after > before + 0.01) {
            const rev = tour.slice(i + 1, k + 1).reverse();
            tour.splice(i + 1, k - i, ...rev);
            improved = true;
          }
        }
      }
    }
  }

  return [...tour.map((idx) => candidates[idx]), ...unidentified];
}

export interface ChainedAreaPlaceInput<T extends ProximityRecordSignals> {
  key: string;
  displayName: string;
  groupType?: string;
  isUnidentified?: boolean;
  rows: T[];
  meta?: Record<string, any>;
}

export interface ChainedAreaInput<T extends ProximityRecordSignals> {
  key: string;
  displayName: string;
  isUnassigned?: boolean;
  rows: T[];
  places: ChainedAreaPlaceInput<T>[];
  meta?: Record<string, any>;
}

export interface ChainedRoutedPlace<T extends ProximityRecordSignals> {
  key: string;
  displayName: string;
  groupType: string;
  isUnidentified: boolean;
  placeStopNumber: number | null;
  rows: T[];
  meta?: Record<string, any>;
}

export interface ChainedRoutedArea<T extends ProximityRecordSignals> {
  key: string;
  displayName: string;
  isUnassigned: boolean;
  areaStopNumber: number | null;
  transitionedFrom: { areaName: string; placeName: string } | null;
  rows: T[];
  orderedPlaces: ChainedRoutedPlace<T>[];
  meta?: Record<string, any>;
}

/**
 * Full Exit-to-Entry Chained Geographic Route Builder:
 * 1. Orders Places/Streets inside Area #1 by proximity & accessibility (2-opt NN).
 * 2. Takes the LAST visited identified location of Area #i as the exit anchor, then picks
 *    the unvisited Area #(i+1) whose entry locality/area profile is nearest to that exit location.
 * 3. Orients Area #(i+1)'s streets to enter near Area #i's exit and walk smoothly without backtracking.
 * 4. Keeps UNIDENTIFIED streets at the bottom of their Area and UNASSIGNED Area at the end for review.
 */
export function buildChainedAreaAndPlaceRoute<T extends ProximityRecordSignals>(
  areas: ChainedAreaInput<T>[],
  options?: {
    aiAreaOrder?: string[] | null;
    aiPlaceOrdersByArea?: Map<string, string[]>;
    mergePlaceVariants?: boolean;
    sortRowsInsidePlace?: boolean;
  }
): ChainedRoutedArea<T>[] {
  const mergeVariants = options?.mergePlaceVariants !== false;
  const sortRows = options?.sortRowsInsidePlace !== false;

  const unassignedAreas: ChainedAreaInput<T>[] = [];
  const validAreas: ChainedAreaInput<T>[] = [];
  for (const a of areas) {
    if (a.isUnassigned || a.key === '__UNASSIGNED__' || a.displayName.toUpperCase() === 'UNASSIGNED') {
      unassignedAreas.push(a);
    } else {
      validAreas.push(a);
    }
  }

  const preparePlaces = (area: ChainedAreaInput<T>): ChainedAreaPlaceInput<T>[] => {
    if (!mergeVariants) return area.places;
    const merged = mergeVariantGeoGroups(
      area.places.map((p) => ({
        key: p.key,
        displayName: p.displayName,
        isUnidentified: p.isUnidentified,
        rows: p.rows,
      }))
    );
    const byKey = new Map(area.places.map((p) => [p.key, p]));
    return merged.map((mg) => ({
      key: mg.key,
      displayName: mg.displayName,
      groupType: byKey.get(mg.key)?.groupType || (mg.isUnidentified ? 'UNIDENTIFIED' : 'SUB_AREA'),
      isUnidentified: Boolean(mg.isUnidentified),
      rows: mg.rows,
      meta: byKey.get(mg.key)?.meta,
    }));
  };

  const routeAreaPlaces = (
    area: ChainedAreaInput<T>,
    prepared: ChainedAreaPlaceInput<T>[],
    entryRef?: { label?: string | null; rows: T[] } | null
  ): ChainedRoutedPlace<T>[] => {
    const byKey = new Map(prepared.map((p) => [p.key, p]));
    const ordered = orderGeoGroupsByProximity(
      prepared.map((p) => ({
        key: p.key,
        displayName: p.displayName,
        isUnidentified: p.isUnidentified,
        rows: p.rows,
      })),
      {
        aiOrderedKeys: options?.aiPlaceOrdersByArea?.get(area.key) || null,
        entryReference: entryRef,
      }
    );
    let stopCounter = 1;
    return ordered.map((og) => {
      const orig = byKey.get(og.key);
      const isUnid = Boolean(og.isUnidentified || og.key === '__UNIDENTIFIED__' || og.displayName.toUpperCase() === 'UNIDENTIFIED');
      return {
        key: og.key,
        displayName: og.displayName,
        groupType: orig?.groupType || (isUnid ? 'UNIDENTIFIED' : 'SUB_AREA'),
        isUnidentified: isUnid,
        placeStopNumber: isUnid ? null : stopCounter++,
        rows: sortRows ? sortRecordsForFieldRoute(og.rows) : og.rows,
        meta: orig?.meta,
      };
    });
  };

  const result: ChainedRoutedArea<T>[] = [];

  if (validAreas.length > 0) {
    const aiAreaRank = new Map<string, number>();
    if (options?.aiAreaOrder && options.aiAreaOrder.length > 0) {
      options.aiAreaOrder.forEach((k, idx) => {
        aiAreaRank.set(k, idx);
        aiAreaRank.set(normalizeGeoGroupKey(k), idx);
      });
    }

    const preparedByAreaKey = new Map<string, ChainedAreaPlaceInput<T>[]>();
    const areaProfileByKey = new Map<string, GroupSpatialProfile>();
    const placeProfilesByAreaKey = new Map<string, GroupSpatialProfile[]>();

    validAreas.forEach((area, idx) => {
      const prep = preparePlaces(area);
      preparedByAreaKey.set(area.key, prep);
      areaProfileByKey.set(
        area.key,
        buildSpatialProfile(idx, { key: area.key, displayName: area.displayName, rows: area.rows })
      );
      placeProfilesByAreaKey.set(
        area.key,
        prep
          .filter((p) => !p.isUnidentified && p.key !== '__UNIDENTIFIED__')
          .map((p, pIdx) => buildSpatialProfile(pIdx, { key: p.key, displayName: p.displayName, rows: p.rows }))
      );
    });

    // Pick initial Area #1 anchor
    let startAreaIdx = 0;
    let bestAnchorScore = -Infinity;
    for (let i = 0; i < validAreas.length; i++) {
      const a = validAreas[i];
      const rank = aiAreaRank.get(a.key) ?? aiAreaRank.get(normalizeGeoGroupKey(a.displayName));
      if (rank === 0) {
        startAreaIdx = i;
        break;
      }
      const prof = areaProfileByKey.get(a.key)!;
      const minZone = prof.zones.size > 0 ? Math.min(...Array.from(prof.zones)) : 999;
      let totalAff = 0;
      for (let j = 0; j < validAreas.length; j++) {
        if (i === j) continue;
        totalAff += computeProximityAffinity(prof, areaProfileByKey.get(validAreas[j].key)!);
      }
      const score = (minZone < 999 ? (100 - minZone) * 2 : 0) + Math.min(35, prof.size) + totalAff * 0.15;
      if (score > bestAnchorScore) {
        bestAnchorScore = score;
        startAreaIdx = i;
      }
    }

    const used = new Set<number>([startAreaIdx]);
    const firstArea = validAreas[startAreaIdx];
    const firstPlaces = routeAreaPlaces(firstArea, preparedByAreaKey.get(firstArea.key)!, null);

    result.push({
      key: firstArea.key,
      displayName: firstArea.displayName,
      isUnassigned: false,
      areaStopNumber: 1,
      transitionedFrom: null,
      rows: firstPlaces.flatMap((p) => p.rows),
      orderedPlaces: firstPlaces,
      meta: firstArea.meta,
    });

    while (used.size < validAreas.length) {
      const prevRouted = result[result.length - 1];
      const prevAreaProf = areaProfileByKey.get(prevRouted.key)!;
      const namedPlacesPrev = prevRouted.orderedPlaces.filter((p) => !p.isUnidentified && p.rows.length > 0);
      const exitPlace = namedPlacesPrev[namedPlacesPrev.length - 1] || null;
      const exitRows = exitPlace ? exitPlace.rows : prevRouted.rows;
      const exitLabel = exitPlace ? exitPlace.displayName : prevRouted.displayName;
      const exitProfile = buildSpatialProfile(-1, {
        key: '__EXIT__',
        displayName: exitLabel,
        rows: exitRows,
      });

      let bestNextIdx = -1;
      let bestScore = -Infinity;

      for (let i = 0; i < validAreas.length; i++) {
        if (used.has(i)) continue;
        const cand = validAreas[i];
        const candProf = areaProfileByKey.get(cand.key)!;
        const candPlaceProfs = placeProfilesByAreaKey.get(cand.key) || [];

        const areaAff = computeProximityAffinity(prevAreaProf, candProf, aiAreaRank.size > 0 ? aiAreaRank : undefined);
        let bestEntryPlaceAff = 0;
        for (const pp of candPlaceProfs) {
          const aff = computeProximityAffinity(exitProfile, pp);
          if (aff > bestEntryPlaceAff) bestEntryPlaceAff = aff;
        }

        let aiTransitionBonus = 0;
        const prevAi = aiAreaRank.get(prevRouted.key) ?? aiAreaRank.get(normalizeGeoGroupKey(prevRouted.displayName));
        const candAi = aiAreaRank.get(cand.key) ?? aiAreaRank.get(normalizeGeoGroupKey(cand.displayName));
        if (prevAi !== undefined && candAi !== undefined) {
          const stepDiff = Math.abs(candAi - prevAi);
          if (stepDiff === 1) aiTransitionBonus = 50;
          else if (stepDiff === 2) aiTransitionBonus = 20;
        }

        const combinedScore = bestEntryPlaceAff * 1.15 + areaAff * 0.65 + aiTransitionBonus;
        const bestPrevMedian =
          bestNextIdx >= 0 ? (areaProfileByKey.get(validAreas[bestNextIdx].key)?.medianRow ?? Infinity) : Infinity;
        if (
          combinedScore > bestScore ||
          (Math.abs(combinedScore - bestScore) < 0.001 && candProf.medianRow < bestPrevMedian)
        ) {
          bestScore = combinedScore;
          bestNextIdx = i;
        }
      }

      if (bestNextIdx === -1) break;
      used.add(bestNextIdx);

      const nextArea = validAreas[bestNextIdx];
      const routedPlaces = routeAreaPlaces(
        nextArea,
        preparedByAreaKey.get(nextArea.key)!,
        { label: exitLabel, rows: exitRows }
      );

      result.push({
        key: nextArea.key,
        displayName: nextArea.displayName,
        isUnassigned: false,
        areaStopNumber: result.length + 1,
        transitionedFrom: {
          areaName: prevRouted.displayName,
          placeName: exitPlace ? exitPlace.displayName : prevRouted.displayName,
        },
        rows: routedPlaces.flatMap((p) => p.rows),
        orderedPlaces: routedPlaces,
        meta: nextArea.meta,
      });
    }
  }

  for (const ua of unassignedAreas) {
    const prep = preparePlaces(ua);
    const routedPlaces = routeAreaPlaces(ua, prep, null);
    result.push({
      key: ua.key,
      displayName: ua.displayName,
      isUnassigned: true,
      areaStopNumber: null,
      transitionedFrom: null,
      rows: routedPlaces.flatMap((p) => p.rows),
      orderedPlaces: routedPlaces,
      meta: ua.meta,
    });
  }

  return result;
}

function extractDoorSortParts(raw: ProximityRecordSignals): { streetKey: string; doorNum: number; doorRaw: string; rowNum: number } {
  const rawAddr = extractRecordRawAddressText(raw);
  const parsed = parseAddressHierarchy(rawAddr);
  const streetKey = (raw.street || parsed.street || '').toLowerCase();
  const doorRaw = parsed.doorOrHouseNo || rawAddr.slice(0, 24);
  const numMatch = doorRaw.match(/(\d+)/);
  const doorNum = numMatch ? Number(numMatch[1]) : Number.MAX_SAFE_INTEGER;
  const rowNum = Number(raw.original_row_number || raw.row_number || 0);
  return { streetKey, doorNum, doorRaw, rowNum };
}

/**
 * Sorts customer records within a single Place / Locality group for convenient door-by-door field visits:
 * street name -> natural house/door number -> source row number.
 */
export function sortRecordsForFieldRoute<T extends ProximityRecordSignals>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const ka = extractDoorSortParts(a);
    const kb = extractDoorSortParts(b);
    if (ka.streetKey !== kb.streetKey) {
      if (!ka.streetKey) return 1;
      if (!kb.streetKey) return -1;
      const cmp = naturalGeoCompare(ka.streetKey, kb.streetKey);
      if (cmp !== 0) return cmp;
    }
    if (ka.doorNum !== kb.doorNum) {
      return ka.doorNum - kb.doorNum;
    }
    if (ka.doorRaw !== kb.doorRaw) {
      const cmpDoor = naturalGeoCompare(ka.doorRaw, kb.doorRaw);
      if (cmpDoor !== 0) return cmpDoor;
    }
    return ka.rowNum - kb.rowNum;
  });
}

