/**
 * Capture-time redaction (M3 — SECURITY_PRIVACY_GOVERNANCE data-minimization,
 * BUILD_PLAN M4 pulled forward). Runs BEFORE storage and therefore before
 * enrichment, audit, and any cloud call: what the detectors catch never
 * exists anywhere downstream. Pattern-based v0 — high-precision detectors
 * only. Street addresses are deliberately NOT detected: no regex reaches
 * acceptable precision, and false positives destroy real content (the docs'
 * ML detector pass is future work).
 */

import { isDataUrl } from "./data-url.js";

export type RedactionType =
  | "email"
  | "phone"
  | "card"
  | "api_key"
  | "ssn"
  | "iban";

export interface RedactionHit {
  type: RedactionType;
  count: number;
}

export interface RedactionResult {
  text: string;
  hits: RedactionHit[];
  total: number;
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

interface Detector {
  type: RedactionType;
  pattern: RegExp;
  validate?: (match: string) => boolean;
}

// Order matters: longer/stronger matches run first so e.g. an API key that
// contains digits isn't partially eaten by the phone detector.
const DETECTORS: Detector[] = [
  {
    // Known key prefixes + generic long secrets assigned to secret-ish names.
    type: "api_key",
    pattern:
      /\b(?:sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[bapr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}|(?:api[_-]?key|token|secret|password|passwd|bearer)["'\s:=]{1,5}[A-Za-z0-9_\-./+]{16,})/gi,
  },
  { type: "email", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { type: "ssn", pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  { type: "iban", pattern: /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}\b/g },
  {
    // 13-19 digits with optional space/dash separators, Luhn-validated to
    // avoid eating order numbers and timestamps.
    type: "card",
    pattern: /\b(?:\d[ -]?){13,19}\b/g,
    validate: (match) => {
      const digits = match.replace(/[^0-9]/g, "");
      return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
    },
  },
  {
    // Conservative: international (+CC...) or clearly formatted NA numbers.
    type: "phone",
    pattern: /(?:\+\d{1,3}[ .-]?)?(?:\(\d{3}\)[ .-]?|\b\d{3}[.-])\d{3}[ .-]?\d{4}\b|\+\d{1,3}[ ]?\d{2,4}[ ]?\d{3,4}[ ]?\d{3,4}\b/g,
  },
];

export interface SensitiveRange {
  start: number;
  end: number;
  type: RedactionType;
}

/** Character ranges the detectors would redact — used by visual redaction
 * (M7) to map OCR line text back onto word bounding boxes. Same detectors,
 * same precision guarantees as redactText. */
export function findSensitiveRanges(text: string): SensitiveRange[] {
  const ranges: SensitiveRange[] = [];
  for (const detector of DETECTORS) {
    const pattern = new RegExp(detector.pattern.source, detector.pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (match[0].length === 0) {
        pattern.lastIndex += 1;
        continue;
      }
      if (detector.validate && !detector.validate(match[0])) continue;
      ranges.push({ start: match.index, end: match.index + match[0].length, type: detector.type });
    }
  }
  return ranges;
}

export function redactText(input: string): RedactionResult {
  let text = input;
  const counts = new Map<RedactionType, number>();
  for (const detector of DETECTORS) {
    text = text.replace(detector.pattern, (match) => {
      if (detector.validate && !detector.validate(match)) return match;
      counts.set(detector.type, (counts.get(detector.type) ?? 0) + 1);
      return `[REDACTED:${detector.type}]`;
    });
  }
  const hits = [...counts.entries()].map(([type, count]) => ({ type, count }));
  return { text, hits, total: hits.reduce((n, h) => n + h.count, 0) };
}

/** Redact every string field of a JSON-ish value in place (returns a copy). */
export function redactDeep<T>(value: T, tally?: Map<RedactionType, number>): T {
  if (typeof value === "string") {
    const result = redactText(value);
    if (tally) {
      for (const hit of result.hits) {
        tally.set(hit.type, (tally.get(hit.type) ?? 0) + hit.count);
      }
    }
    return result.text as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactDeep(v, tally)) as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Data URLs (screenshots) are binary payloads, not text to scan.
      // Case-insensitive (M15C): `DATA:...` is still a data URI.
      out[k] = isDataUrl(v) ? v : redactDeep(v, tally);
    }
    return out as T;
  }
  return value;
}
