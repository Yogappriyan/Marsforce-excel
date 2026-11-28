import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import type { TargetField } from '../../infrastructure/llm/LLMProvider.ts';

export type ProvenanceType = 'EXTRACTED' | 'STANDARDISED' | 'INFERRED';

export interface ValidationIssue {
  code: string;
  field: string;
  severity: 'ERROR' | 'WARN' | 'INFO';
  message: string;
}

export interface ParsedPhone {
  raw: string;
  e164: string | null;
  display: string | null;
  valid: boolean;
  reason?: string;
}

export interface StructuredRecordOutput {
  consumerId: string | null;
  distributorId: string | null;
  fullName: string | null;
  normalizedName: string | null;
  street: string | null;
  subArea: string | null;
  area: string | null;
  city: string | null;
  district: string | null;
  state: string | null;
  pinCode: string | null;
  phoneE164: string | null;
  phoneDisplay: string | null;
  secondaryPhones: ParsedPhone[];
  otherFields: Record<string, string>;
  provenance: Record<string, ProvenanceType>;
  fieldConfidence: Record<string, number>;
  overallConfidence: number;
  hasInferredFields: boolean;
  issues: ValidationIssue[];
  status: 'PROCESSED' | 'VERIFIED' | 'NEEDS_REVIEW' | 'INVALID';
}

// Offline Indian Postal Prefix Map (first 2/3 digits -> State + primary District/Region hint)
// Any field populated from this lookup is tagged provenance = 'INFERRED' and flagged for review.
const IN_PIN_PREFIX_MAP: Record<string, { state: string; districtHint?: string }> = {
  '11': { state: 'Delhi', districtHint: 'New Delhi' },
  '12': { state: 'Haryana' },
  '13': { state: 'Haryana' },
  '14': { state: 'Punjab' },
  '15': { state: 'Punjab' },
  '16': { state: 'Chandigarh' },
  '20': { state: 'Uttar Pradesh' },
  '22': { state: 'Uttar Pradesh', districtHint: 'Lucknow' },
  '28': { state: 'Uttar Pradesh' },
  '30': { state: 'Rajasthan', districtHint: 'Jaipur' },
  '38': { state: 'Gujarat', districtHint: 'Ahmedabad' },
  '39': { state: 'Gujarat', districtHint: 'Surat' },
  '40': { state: 'Maharashtra', districtHint: 'Mumbai' },
  '41': { state: 'Maharashtra', districtHint: 'Pune' },
  '44': { state: 'Maharashtra', districtHint: 'Nagpur' },
  '45': { state: 'Madhya Pradesh', districtHint: 'Indore' },
  '50': { state: 'Telangana', districtHint: 'Hyderabad' },
  '51': { state: 'Andhra Pradesh' },
  '52': { state: 'Andhra Pradesh', districtHint: 'Vijayawada' },
  '53': { state: 'Andhra Pradesh', districtHint: 'Visakhapatnam' },
  '56': { state: 'Karnataka', districtHint: 'Bengaluru' },
  '57': { state: 'Karnataka', districtHint: 'Mysuru' },
  '60': { state: 'Tamil Nadu', districtHint: 'Chennai' },
  '61': { state: 'Tamil Nadu', districtHint: 'Thanjavur' },
  '62': { state: 'Tamil Nadu', districtHint: 'Madurai' },
  '63': { state: 'Tamil Nadu', districtHint: 'Salem' },
  '64': { state: 'Tamil Nadu', districtHint: 'Coimbatore' },
  '67': { state: 'Kerala', districtHint: 'Kozhikode' },
  '68': { state: 'Kerala', districtHint: 'Ernakulam' },
  '69': { state: 'Kerala', districtHint: 'Thiruvananthapuram' },
  '70': { state: 'West Bengal', districtHint: 'Kolkata' },
  '75': { state: 'Odisha', districtHint: 'Bhubaneswar' },
  '78': { state: 'Assam', districtHint: 'Kamrup' },
  '80': { state: 'Bihar', districtHint: 'Patna' },
};

const KNOWN_PIN_3_DISTRICT: Record<string, { city: string; district: string; state: string }> = {
  '600': { city: 'Chennai', district: 'Chennai', state: 'Tamil Nadu' },
  '625': { city: 'Madurai', district: 'Madurai', state: 'Tamil Nadu' },
  '627': { city: 'Tirunelveli', district: 'Tirunelveli', state: 'Tamil Nadu' },
  '641': { city: 'Coimbatore', district: 'Coimbatore', state: 'Tamil Nadu' },
  '620': { city: 'Tiruchirappalli', district: 'Tiruchirappalli', state: 'Tamil Nadu' },
  '636': { city: 'Salem', district: 'Salem', state: 'Tamil Nadu' },
  '638': { city: 'Erode', district: 'Erode', state: 'Tamil Nadu' },
  '613': { city: 'Thanjavur', district: 'Thanjavur', state: 'Tamil Nadu' },
  '628': { city: 'Thoothukudi', district: 'Thoothukudi', state: 'Tamil Nadu' },
  '629': { city: 'Nagercoil', district: 'Kanyakumari', state: 'Tamil Nadu' },
  '560': { city: 'Bengaluru', district: 'Bengaluru Urban', state: 'Karnataka' },
  '500': { city: 'Hyderabad', district: 'Hyderabad', state: 'Telangana' },
  '400': { city: 'Mumbai', district: 'Mumbai', state: 'Maharashtra' },
  '411': { city: 'Pune', district: 'Pune', state: 'Maharashtra' },
  '110': { city: 'New Delhi', district: 'New Delhi', state: 'Delhi' },
  '700': { city: 'Kolkata', district: 'Kolkata', state: 'West Bengal' },
};

const KNOWN_CITIES: Record<string, { district: string; state: string }> = {
  madurai: { district: 'Madurai', state: 'Tamil Nadu' },
  tirunelveli: { district: 'Tirunelveli', state: 'Tamil Nadu' },
  chennai: { district: 'Chennai', state: 'Tamil Nadu' },
  coimbatore: { district: 'Coimbatore', state: 'Tamil Nadu' },
  salem: { district: 'Salem', state: 'Tamil Nadu' },
  trichy: { district: 'Tiruchirappalli', state: 'Tamil Nadu' },
  tiruchirappalli: { district: 'Tiruchirappalli', state: 'Tamil Nadu' },
  erode: { district: 'Erode', state: 'Tamil Nadu' },
  thanjavur: { district: 'Thanjavur', state: 'Tamil Nadu' },
  vellore: { district: 'Vellore', state: 'Tamil Nadu' },
  thoothukudi: { district: 'Thoothukudi', state: 'Tamil Nadu' },
  tuticorin: { district: 'Thoothukudi', state: 'Tamil Nadu' },
  nagercoil: { district: 'Kanyakumari', state: 'Tamil Nadu' },
  bengaluru: { district: 'Bengaluru Urban', state: 'Karnataka' },
  bangalore: { district: 'Bengaluru Urban', state: 'Karnataka' },
  hyderabad: { district: 'Hyderabad', state: 'Telangana' },
  mumbai: { district: 'Mumbai', state: 'Maharashtra' },
  pune: { district: 'Pune', state: 'Maharashtra' },
  kochi: { district: 'Ernakulam', state: 'Kerala' },
  delhi: { district: 'New Delhi', state: 'Delhi' },
  'new delhi': { district: 'New Delhi', state: 'Delhi' },
  kolkata: { district: 'Kolkata', state: 'West Bengal' },
};

const STATE_ALIASES: Record<string, string> = {
  tn: 'Tamil Nadu',
  'tamil nadu': 'Tamil Nadu',
  tamilnadu: 'Tamil Nadu',
  ka: 'Karnataka',
  karnataka: 'Karnataka',
  kl: 'Kerala',
  kerala: 'Kerala',
  ap: 'Andhra Pradesh',
  'andhra pradesh': 'Andhra Pradesh',
  ts: 'Telangana',
  telangana: 'Telangana',
  mh: 'Maharashtra',
  maharashtra: 'Maharashtra',
  dl: 'Delhi',
  delhi: 'Delhi',
  wb: 'West Bengal',
  'west bengal': 'West Bengal',
  gj: 'Gujarat',
  gujarat: 'Gujarat',
  rj: 'Rajasthan',
  rajasthan: 'Rajasthan',
  up: 'Uttar Pradesh',
  'uttar pradesh': 'Uttar Pradesh',
};

export function cleanText(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  const normalized = String(val)
    .normalize('NFC')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized || /^(na|n\/a|null|nil|none|-+|_+)$/i.test(normalized)) {
    return null;
  }
  return normalized;
}

// Preserves Tamil/Indic Unicode characters intact while title-casing ASCII Latin tokens
export function smartTitleCase(text: string): string {
  // Never mutate formula-like cell values so neutralization stays exact
  if (/^[=+\-@\t\r]/.test(text)) return text;
  return text
    .split(' ')
    .map((word) => {
      if (!word) return '';
      // If contains non-ASCII script (e.g. Tamil), leave script intact
      if (/[^\u0000-\u007F]/.test(word)) return word;
      if (/^[A-Z]{2,4}$/.test(word)) return word; // Acronyms like TN, Pvt, GST
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

export function normalizeForMatch(text: string | null): string | null {
  if (!text) return null;
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseAndStandardizePhones(rawCell: string | null, defaultRegion: CountryCode = 'IN'): ParsedPhone[] {
  if (!rawCell) return [];
  const cleaned = rawCell.normalize('NFC').trim();
  if (!cleaned) return [];

  // Split multi-phone cells on comma, semicolon, pipe, newline, or slash when separating numbers
  const segments = cleaned
    .split(/[\n,;|]+|\s+\/\s+|(?<=\d{7,})\s*\/\s*(?=[+\d])/)
    .map((s) => s.trim())
    .filter(Boolean);

  const results: ParsedPhone[] = [];
  const seenE164 = new Set<string>();

  for (const segment of segments) {
    const digitsOnly = segment.replace(/\D/g, '');
    if (!digitsOnly) continue;

    // Specific Indian mobile normalization & strict check
    if (defaultRegion === 'IN') {
      let local10 = digitsOnly;
      if (local10.startsWith('91') && local10.length === 12) {
        local10 = local10.slice(2);
      } else if (local10.startsWith('091') && local10.length === 13) {
        local10 = local10.slice(3);
      } else if (local10.startsWith('0') && local10.length === 11) {
        local10 = local10.slice(1);
      }

      if (local10.length === 10 && /^[6-9]\d{9}$/.test(local10)) {
        const e164 = `+91${local10}`;
        if (!seenE164.has(e164)) {
          seenE164.add(e164);
          results.push({
            raw: segment,
            e164,
            display: `+91 ${local10.slice(0, 5)} ${local10.slice(5)}`,
            valid: true,
          });
        }
        continue;
      }

      // Check STD landline via libphonenumber-js
      const parsed = parsePhoneNumberFromString(segment, 'IN');
      if (parsed && parsed.isValid()) {
        const e164 = parsed.number;
        if (!seenE164.has(e164)) {
          seenE164.add(e164);
          results.push({
            raw: segment,
            e164,
            display: parsed.formatInternational(),
            valid: true,
          });
        }
        continue;
      }

      results.push({
        raw: segment,
        e164: null,
        display: null,
        valid: false,
        reason:
          local10.length === 10 && !/^[6-9]/.test(local10)
            ? 'Indian mobile numbers must start with digits 6, 7, 8, or 9.'
            : `Expected 10-digit Indian mobile or valid phone number (found ${digitsOnly.length} digits).`,
      });
    } else {
      const parsed = parsePhoneNumberFromString(segment, defaultRegion);
      if (parsed && parsed.isValid()) {
        const e164 = parsed.number;
        if (!seenE164.has(e164)) {
          seenE164.add(e164);
          results.push({
            raw: segment,
            e164,
            display: parsed.formatInternational(),
            valid: true,
          });
        }
      } else {
        results.push({
          raw: segment,
          e164: null,
          display: null,
          valid: false,
          reason: `Could not validate phone number for region ${defaultRegion}.`,
        });
      }
    }
  }

  return results;
}

export function splitNameAndPhoneCell(raw: string | null): { name: string | null; phoneText: string | null } {
  if (!raw) return { name: null, phoneText: null };
  const phoneMatches = raw.match(/(?:\+?91[\s-]?)?(?:0)?[6-9]\d{4}[\s-]?\d{5}|\+?\d[\d\s-]{6,14}\d/g);
  if (!phoneMatches || phoneMatches.length === 0) {
    return { name: cleanText(raw), phoneText: null };
  }
  let remaining = raw;
  for (const m of phoneMatches) {
    remaining = remaining.replace(m, ' ');
  }
  remaining = remaining.replace(/[\-\/,;|():]+/g, ' ').replace(/\s+/g, ' ').trim();
  return {
    name: cleanText(remaining),
    phoneText: phoneMatches.join(', '),
  };
}

export interface AddressParts {
  street: string | null;
  area: string | null;
  city: string | null;
  district: string | null;
  state: string | null;
  pinCode: string | null;
  confidence: number;
}

export function parseCombinedAddressDeterministic(rawAddress: string | null): AddressParts {
  if (!rawAddress) {
    return { street: null, area: null, city: null, district: null, state: null, pinCode: null, confidence: 0 };
  }

  let working = rawAddress.normalize('NFC').trim();
  let pinCode: string | null = null;
  const pinMatch = working.match(/\b([1-9]\d{5})\b/);
  if (pinMatch) {
    pinCode = pinMatch[1];
    working = working.replace(pinMatch[0], ' ');
  }

  const tokens = working
    .split(/[,;\n]+/)
    .map((t) => t.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  let state: string | null = null;
  let district: string | null = null;
  let city: string | null = null;
  const remainingTokens: string[] = [];

  for (const token of tokens) {
    const low = token.toLowerCase().replace(/\./g, '').trim();
    if (!state && STATE_ALIASES[low]) {
      state = STATE_ALIASES[low];
      continue;
    }
    // Check if token ends with state alias like "Madurai TN"
    let matchedStateSuffix = false;
    for (const [alias, canonical] of Object.entries(STATE_ALIASES)) {
      const suffixRe = new RegExp(`\\s+${alias}$`, 'i');
      if (suffixRe.test(low)) {
        state = canonical;
        const stripped = token.replace(new RegExp(`\\s+${alias}$`, 'i'), '').trim();
        if (stripped) remainingTokens.push(stripped);
        matchedStateSuffix = true;
        break;
      }
    }
    if (matchedStateSuffix) continue;

    // Handle trailing city + zone like "Trichy-17", "Trichy - 18", "Thennur Trichy-17"
    const cityZoneMatch = token.match(
      /^(.*?)(?:[\s.,]+|^)(trichy|tiruchirappalli|madurai|chennai|coimbatore|salem|erode|thanjavur|vellore|tirunelveli|thoothukudi|nagercoil|bengaluru|bangalore|hyderabad|mumbai|pune)(?:\s*[-–]\s*(\d{1,3}))?\.?$/i
    );
    if (cityZoneMatch) {
      const prefix = cityZoneMatch[1].replace(/[.,]+$/, '').trim();
      const cityRaw = cityZoneMatch[2];
      const cityLow = cityRaw.toLowerCase();
      if (!city && KNOWN_CITIES[cityLow]) {
        city = smartTitleCase(cityRaw);
        district = KNOWN_CITIES[cityLow].district;
        if (!state) state = KNOWN_CITIES[cityLow].state;
      }
      if (prefix) {
        remainingTokens.push(prefix);
      }
      continue;
    }

    if (!city && KNOWN_CITIES[low]) {
      city = smartTitleCase(token);
      district = KNOWN_CITIES[low].district;
      if (!state) state = KNOWN_CITIES[low].state;
      continue;
    }
    remainingTokens.push(token);
  }

  // If city still missing, check last remaining token against known cities
  if (!city && remainingTokens.length >= 2) {
    const candidate = remainingTokens[remainingTokens.length - 1];
    const low = candidate.toLowerCase();
    if (KNOWN_CITIES[low]) {
      city = smartTitleCase(candidate);
      district = KNOWN_CITIES[low].district;
      if (!state) state = KNOWN_CITIES[low].state;
      remainingTokens.pop();
    } else if (!/\d/.test(candidate) && candidate.length <= 28 && !/(nagar|colony|patti|kudi|kurichi|mangalam|kovil|koil|puram|street|road|cross)/i.test(low)) {
      city = smartTitleCase(remainingTokens.pop()!);
    }
  }

  let street: string | null = null;
  let area: string | null = null;

  if (remainingTokens.length === 1) {
    street = smartTitleCase(remainingTokens[0]);
  } else if (remainingTokens.length === 2) {
    street = smartTitleCase(remainingTokens[0]);
    area = smartTitleCase(remainingTokens[1]);
  } else if (remainingTokens.length > 2) {
    street = smartTitleCase(remainingTokens.slice(0, remainingTokens.length - 1).join(', '));
    area = smartTitleCase(remainingTokens[remainingTokens.length - 1]);
  }

  let confidence = 0.55;
  if (pinCode) confidence += 0.15;
  if (city) confidence += 0.15;
  if (street) confidence += 0.10;
  if (state) confidence += 0.05;

  return {
    street,
    area,
    city,
    district,
    state,
    pinCode,
    confidence: Math.min(0.95, Number(confidence.toFixed(3))),
  };
}

export function detectColumnsDeterministic(
  headers: string[],
  sampleRows: Record<string, string>[]
): Array<{ sourceIndex: number; sourceColumn: string; targetField: TargetField; confidence: number; reason: string }> {
  return headers.map((header, sourceIndex) => {
    const h = header.toLowerCase().trim();
    const values = sampleRows
      .map((r) => String(r[header] ?? '').trim())
      .filter(Boolean)
      .slice(0, 25);

    // Header heuristics first
    if (/^(consumer[_\s]?(no|num|number|id|code)|cust(omer)?[_\s]?(id|no|num|number|code)|unique[_\s]?id|account[_\s]?(no|id|number)|bp[_\s]?no|connection[_\s]?(no|id))$/i.test(h)) {
      return { sourceIndex, sourceColumn: header, targetField: 'consumer_id', confidence: 0.96, reason: 'Header matches consumer/customer identifier' };
    }
    if (/^(distributor[_\s]?(id|code|no|name)?|agency[_\s]?(id|code)|dealer[_\s]?(id|code))$/i.test(h)) {
      return { sourceIndex, sourceColumn: header, targetField: 'distributor_id', confidence: 0.94, reason: 'Header matches distributor identifier' };
    }
    if (/^(full[_\s]?name|customer[_\s]?name|consumer[_\s]?name|client[_\s]?name|name|contact[_\s]?name|party[_\s]?name)$/i.test(h)) {
      const hasPhones = values.filter((v) => /\d{8,}/.test(v)).length > values.length * 0.3;
      if (hasPhones) {
        return { sourceIndex, sourceColumn: header, targetField: 'name_and_phone', confidence: 0.9, reason: 'Name header with embedded phone numbers' };
      }
      return { sourceIndex, sourceColumn: header, targetField: 'full_name', confidence: 0.96, reason: 'Header matches customer name' };
    }
    if (/(name.*phone|phone.*name|contact.*details|customer.*contact)/i.test(h)) {
      return { sourceIndex, sourceColumn: header, targetField: 'name_and_phone', confidence: 0.9, reason: 'Combined name and phone header' };
    }
    if (/(phone|mobile|mob|cell|whatsapp|tel|contact[_\s]?no)/i.test(h)) {
      const hasMulti = values.some((v) => /[,;|\/]/.test(v) && (v.match(/\d{7,}/g)?.length || 0) >= 2);
      return {
        sourceIndex,
        sourceColumn: header,
        targetField: hasMulti ? 'phone_multi' : 'phone_raw',
        confidence: 0.95,
        reason: hasMulti ? 'Multiple phone numbers detected in cell' : 'Header matches phone/mobile',
      };
    }
    if (/^(pin|pincode|pin[_\s]?code|postal|zip|zipcode)$/i.test(h)) {
      return { sourceIndex, sourceColumn: header, targetField: 'pin_code', confidence: 0.97, reason: 'Header matches PIN/postal code' };
    }
    if (/^(city|town|place)$/i.test(h)) {
      return { sourceIndex, sourceColumn: header, targetField: 'city', confidence: 0.95, reason: 'Header matches city' };
    }
    if (/^(district|dist|taluk)$/i.test(h)) {
      return { sourceIndex, sourceColumn: header, targetField: 'district', confidence: 0.95, reason: 'Header matches district' };
    }
    if (/^(state|province|region)$/i.test(h)) {
      return { sourceIndex, sourceColumn: header, targetField: 'state', confidence: 0.95, reason: 'Header matches state' };
    }
    if (/^(sub[\s_-]?area|subarea|division|ward|sector)$/i.test(h)) {
      return { sourceIndex, sourceColumn: header, targetField: 'sub_area', confidence: 0.92, reason: 'Header matches sub-area' };
    }
    if (/^(street|door|address[_\s]?1|line[_\s]?1|road)$/i.test(h)) {
      return { sourceIndex, sourceColumn: header, targetField: 'street', confidence: 0.9, reason: 'Header matches street' };
    }
    if (/^(area|area[_\s]?name|areaname|zone|locality|landmark|colony|nagar|address[_\s]?2|line[_\s]?2)$/i.test(h)) {
      return { sourceIndex, sourceColumn: header, targetField: 'area', confidence: 0.93, reason: 'Header matches area/zone/locality' };
    }
    if (/(address|location|full[_\s]?addr)/i.test(h)) {
      return { sourceIndex, sourceColumn: header, targetField: 'address_combined', confidence: 0.92, reason: 'Combined address header' };
    }

    // Value-pattern heuristics if header is ambiguous (e.g. "Col A", "Field 1")
    if (values.length > 0) {
      const pinHits = values.filter((v) => /^\d{6}$/.test(v)).length;
      if (pinHits / values.length >= 0.7) {
        return { sourceIndex, sourceColumn: header, targetField: 'pin_code', confidence: 0.88, reason: 'Values match 6-digit PIN codes' };
      }
      const phoneHits = values.filter((v) => /(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}/.test(v)).length;
      if (phoneHits / values.length >= 0.7) {
        return { sourceIndex, sourceColumn: header, targetField: 'phone_raw', confidence: 0.86, reason: 'Values match Indian phone numbers' };
      }
      const addrHits = values.filter((v) => /,/.test(v) && /(rd|road|st|street|nagar|colony|main|\d{6})/i.test(v)).length;
      if (addrHits / values.length >= 0.5) {
        return { sourceIndex, sourceColumn: header, targetField: 'address_combined', confidence: 0.8, reason: 'Values appear to be multi-part addresses' };
      }
    }

    return { sourceIndex, sourceColumn: header, targetField: 'custom', confidence: 0.55, reason: 'Preserved as custom attribute' };
  });
}

export function cleanAndValidateRow(params: {
  rawRow: Record<string, string>;
  mappings: Array<{ sourceColumn: string; targetField: TargetField; customFieldKey?: string | null }>;
  defaultRegion: CountryCode;
  precisionLossCols?: Array<{ column: string; storedValue: string; displayValue: string; reason: string }>;
  aiAddressOverride?: {
    street?: string | null;
    area?: string | null;
    city?: string | null;
    district?: string | null;
    state?: string | null;
    pinCode?: string | null;
    confidence?: number;
  } | null;
}): StructuredRecordOutput {
  const provenance: Record<string, ProvenanceType> = {};
  const fieldConfidence: Record<string, number> = {};
  const otherFields: Record<string, string> = {};
  const issues: ValidationIssue[] = [];

  let consumerId: string | null = null;
  let distributorId: string | null = null;
  let fullName: string | null = null;
  let street: string | null = null;
  let subArea: string | null = null;
  let area: string | null = null;
  let city: string | null = null;
  let district: string | null = null;
  let state: string | null = null;
  let pinCode: string | null = null;
  let rawCombinedAddress: string | null = null;
  const phoneCandidates: string[] = [];

  for (const m of params.mappings) {
    if (m.targetField === 'ignore') continue;
    const rawVal = cleanText(params.rawRow[m.sourceColumn]);
    if (!rawVal) continue;

    switch (m.targetField) {
      case 'consumer_id':
        // Preserve leading zeros and exact string identifier without numeric casting
        consumerId = String(params.rawRow[m.sourceColumn]).trim();
        provenance.consumerId = 'EXTRACTED';
        fieldConfidence.consumerId = 0.99;
        break;
      case 'distributor_id':
        distributorId = String(params.rawRow[m.sourceColumn]).trim();
        provenance.distributorId = 'EXTRACTED';
        fieldConfidence.distributorId = 0.98;
        break;
      case 'full_name':
        fullName = smartTitleCase(rawVal);
        provenance.fullName = rawVal === fullName ? 'EXTRACTED' : 'STANDARDISED';
        fieldConfidence.fullName = 0.96;
        break;
      case 'name_and_phone': {
        const split = splitNameAndPhoneCell(rawVal);
        if (split.name) {
          fullName = smartTitleCase(split.name);
          provenance.fullName = 'EXTRACTED';
          fieldConfidence.fullName = 0.88;
        }
        if (split.phoneText) {
          phoneCandidates.push(split.phoneText);
        }
        break;
      }
      case 'phone_raw':
      case 'phone_multi':
        phoneCandidates.push(rawVal);
        break;
      case 'address_combined':
        rawCombinedAddress = rawCombinedAddress ? `${rawCombinedAddress}, ${rawVal}` : rawVal;
        break;
      case 'street':
        street = smartTitleCase(rawVal);
        provenance.street = rawVal === street ? 'EXTRACTED' : 'STANDARDISED';
        fieldConfidence.street = 0.95;
        break;
      case 'sub_area':
        subArea = smartTitleCase(rawVal);
        provenance.subArea = rawVal === subArea ? 'EXTRACTED' : 'STANDARDISED';
        fieldConfidence.subArea = 0.95;
        break;
      case 'area':
        area = smartTitleCase(rawVal);
        provenance.area = rawVal === area ? 'EXTRACTED' : 'STANDARDISED';
        fieldConfidence.area = 0.95;
        break;
      case 'city':
        city = smartTitleCase(rawVal);
        provenance.city = rawVal === city ? 'EXTRACTED' : 'STANDARDISED';
        fieldConfidence.city = 0.95;
        break;
      case 'district':
        district = smartTitleCase(rawVal);
        provenance.district = rawVal === district ? 'EXTRACTED' : 'STANDARDISED';
        fieldConfidence.district = 0.95;
        break;
      case 'state': {
        const low = rawVal.toLowerCase();
        state = STATE_ALIASES[low] || smartTitleCase(rawVal);
        provenance.state = STATE_ALIASES[low] ? 'STANDARDISED' : 'EXTRACTED';
        fieldConfidence.state = 0.96;
        break;
      }
      case 'pin_code': {
        const digits = rawVal.replace(/\D/g, '');
        if (/^[1-9]\d{5}$/.test(digits)) {
          pinCode = digits;
          provenance.pinCode = digits === rawVal ? 'EXTRACTED' : 'STANDARDISED';
          fieldConfidence.pinCode = 0.98;
        } else {
          pinCode = rawVal.slice(0, 6);
          provenance.pinCode = 'EXTRACTED';
          fieldConfidence.pinCode = 0.4;
          issues.push({
            code: 'INVALID_PIN_CODE',
            field: 'pinCode',
            severity: 'ERROR',
            message: `PIN code "${rawVal}" is not a valid 6-digit Indian postal code.`,
          });
        }
        break;
      }
      case 'custom': {
        const key = m.customFieldKey || m.sourceColumn;
        otherFields[key] = rawVal;
        break;
      }
    }
  }

  // Flag source scientific-notation or Excel float64 precision-loss columns cleanly
  if (params.precisionLossCols && params.precisionLossCols.length > 0) {
    for (const pl of params.precisionLossCols) {
      issues.push({
        code: 'NUMERIC_PRECISION_OR_SCI_NOTATION',
        field: pl.column,
        severity: 'WARN',
        message: `Column "${pl.column}" (${pl.displayValue}): ${pl.reason}`,
      });
    }
  }

  // Parse combined address (rules first, then combine optional AI extraction for missing tokens)
  if (rawCombinedAddress) {
    const det = parseCombinedAddressDeterministic(rawCombinedAddress);
    const ai = params.aiAddressOverride;
    const fuseConfidence = (ruleScore: number, aiScore?: number) =>
      aiScore ? Number(Math.min(0.95, 0.4 * ruleScore + 0.6 * aiScore).toFixed(3)) : ruleScore;

    if (!street && (det.street || ai?.street)) {
      street = smartTitleCase((det.street || ai?.street)!);
      provenance.street = 'EXTRACTED';
      fieldConfidence.street = fuseConfidence(det.confidence, ai?.confidence);
    }
    if (!area && (det.area || ai?.area)) {
      area = smartTitleCase((det.area || ai?.area)!);
      provenance.area = 'EXTRACTED';
      fieldConfidence.area = fuseConfidence(det.confidence, ai?.confidence);
    }
    if (!city && (det.city || ai?.city)) {
      city = smartTitleCase((det.city || ai?.city)!);
      provenance.city = 'EXTRACTED';
      fieldConfidence.city = fuseConfidence(det.confidence, ai?.confidence);
    }
    if (!district && (det.district || ai?.district)) {
      district = smartTitleCase((det.district || ai?.district)!);
      provenance.district = 'EXTRACTED';
      fieldConfidence.district = fuseConfidence(det.confidence, ai?.confidence);
    }
    if (!state && (det.state || ai?.state)) {
      const rawSt = (det.state || ai?.state)!;
      state = STATE_ALIASES[rawSt.toLowerCase()] || smartTitleCase(rawSt);
      provenance.state = STATE_ALIASES[rawSt.toLowerCase()] ? 'STANDARDISED' : 'EXTRACTED';
      fieldConfidence.state = fuseConfidence(det.confidence, ai?.confidence);
    }
    if (!pinCode && (det.pinCode || ai?.pinCode)) {
      const cand = (det.pinCode || ai?.pinCode)!.replace(/\D/g, '');
      if (/^[1-9]\d{5}$/.test(cand)) {
        pinCode = cand;
        provenance.pinCode = 'EXTRACTED';
        fieldConfidence.pinCode = 0.96;
      }
    }
  }

  // Infer District/State/City from valid PIN or known City ONLY when missing, strictly tagged INFERRED
  let hasInferredFields = false;
  if (pinCode && /^[1-9]\d{5}$/.test(pinCode)) {
    const prefix3 = pinCode.slice(0, 3);
    const prefix2 = pinCode.slice(0, 2);
    const exact3 = KNOWN_PIN_3_DISTRICT[prefix3];
    const hint2 = IN_PIN_PREFIX_MAP[prefix2];

    if (!city && exact3?.city) {
      city = exact3.city;
      provenance.city = 'INFERRED';
      fieldConfidence.city = 0.78;
      hasInferredFields = true;
    }
    if (!district && exact3?.district) {
      district = exact3.district;
      provenance.district = 'INFERRED';
      fieldConfidence.district = 0.80;
      hasInferredFields = true;
    }
    if (!state && (exact3?.state || hint2?.state)) {
      state = exact3?.state || hint2!.state;
      provenance.state = 'INFERRED';
      fieldConfidence.state = 0.85;
      hasInferredFields = true;
    }
  }
  if (city && (!district || !state)) {
    const cityLookup = KNOWN_CITIES[city.toLowerCase()];
    if (cityLookup) {
      if (!district) {
        district = cityLookup.district;
        provenance.district = 'INFERRED';
        fieldConfidence.district = 0.82;
        hasInferredFields = true;
      }
      if (!state) {
        state = cityLookup.state;
        provenance.state = 'INFERRED';
        fieldConfidence.state = 0.85;
        hasInferredFields = true;
      }
    }
  }

  if (hasInferredFields) {
    issues.push({
      code: 'INFERRED_VALUE_REQUIRES_REVIEW',
      field: 'address',
      severity: 'INFO',
      message: 'One or more location fields (city/district/state) were inferred from PIN or city lookup and require human review.',
    });
  }

  // Parse and standardize phones
  const allPhones = parseAndStandardizePhones(phoneCandidates.join(', '), params.defaultRegion);
  const validPhones = allPhones.filter((p) => p.valid && p.e164);
  const invalidPhones = allPhones.filter((p) => !p.valid);

  const primaryPhone = validPhones[0] || null;
  const secondaryPhones = validPhones.slice(1);

  if (primaryPhone) {
    provenance.phoneE164 = primaryPhone.raw === primaryPhone.e164 ? 'EXTRACTED' : 'STANDARDISED';
    fieldConfidence.phoneE164 = 0.98;
  }

  for (const bad of invalidPhones) {
    issues.push({
      code: 'INVALID_PHONE_FORMAT',
      field: 'phoneE164',
      severity: 'ERROR',
      message: `Invalid phone "${bad.raw}": ${bad.reason}`,
    });
  }

  if (!fullName) {
    issues.push({
      code: 'MISSING_NAME',
      field: 'fullName',
      severity: 'WARN',
      message: 'Customer or entity name is missing in this record.',
    });
  }
  if (allPhones.length === 0) {
    issues.push({
      code: 'MISSING_PHONE',
      field: 'phoneE164',
      severity: 'WARN',
      message: 'No phone number found in this record.',
    });
  }
  if (!street && !area && !city) {
    issues.push({
      code: 'INCOMPLETE_ADDRESS',
      field: 'address',
      severity: 'WARN',
      message: 'Address is incomplete (missing street, area, and city).',
    });
  }

  const confValues = Object.values(fieldConfidence);
  const overallConfidence =
    confValues.length > 0
      ? Number((confValues.reduce((a, b) => a + b, 0) / confValues.length).toFixed(3))
      : 0;

  const hasError = issues.some((i) => i.severity === 'ERROR');
  const hasWarn = issues.some((i) => i.severity === 'WARN');

  let status: StructuredRecordOutput['status'] = 'PROCESSED';
  if (hasError) {
    status = 'INVALID';
  } else if (hasInferredFields || hasWarn || overallConfidence < 0.8) {
    status = 'NEEDS_REVIEW';
  } else if (overallConfidence >= 0.94 && issues.length === 0) {
    status = 'VERIFIED';
  }

  return {
    consumerId,
    distributorId,
    fullName,
    normalizedName: normalizeForMatch(fullName),
    street,
    subArea,
    area,
    city,
    district,
    state,
    pinCode,
    phoneE164: primaryPhone?.e164 || null,
    phoneDisplay: primaryPhone?.display || null,
    secondaryPhones,
    otherFields,
    provenance,
    fieldConfidence,
    overallConfidence,
    hasInferredFields,
    issues,
    status,
  };
}
