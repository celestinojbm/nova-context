import { createHash } from "node:crypto";

/**
 * M20a heuristic fact extractor (docs/design/memoria-m20.md §1.1).
 * Pure, local, deterministic: no LLM, no network. Turns the already-redacted
 * text of a Context Moment into 0..N short declarative "facts".
 *
 * Heuristics (ES + EN):
 *  - split into sentences/lines;
 *  - drop questions, imperatives/requests, very short or very long sentences;
 *  - drop sentences containing redaction markers ([REDACTED], ███, ****);
 *  - keep sentences that look like stable statements: a copula/possession/
 *    preference/decision verb, or a key: value pair, or a date/number attribute.
 */

export const EXTRACTOR_ID = "heuristic-v1";
export const MAX_FACTS_PER_MOMENT = 20;

export interface ExtractedFact {
  content: string;
  content_hash: string;
  kind: "preference" | "decision" | "attribute" | "statement";
}

const REDACTION_MARKERS = /\[(?:redacted|redactado|oculto)[^\]]*\]|█|\*{4,}|<redacted>/i;

const QUESTION_START =
  /^(?:¿|qu[eé](?![\p{L}\p{N}])|c[oó]mo(?![\p{L}\p{N}])|cu[aá]ndo(?![\p{L}\p{N}])|d[oó]nde(?![\p{L}\p{N}])|por qu[eé](?![\p{L}\p{N}])|cu[aá]l(?![\p{L}\p{N}])|qui[eé]n(?![\p{L}\p{N}])|what(?![\p{L}\p{N}])|how(?![\p{L}\p{N}])|when(?![\p{L}\p{N}])|where(?![\p{L}\p{N}])|why(?![\p{L}\p{N}])|which(?![\p{L}\p{N}])|who(?![\p{L}\p{N}])|is(?![\p{L}\p{N}])|are(?![\p{L}\p{N}])|do(?![\p{L}\p{N}])|does(?![\p{L}\p{N}])|can(?![\p{L}\p{N}])|could(?![\p{L}\p{N}])|should(?![\p{L}\p{N}]))/iu;

const IMPERATIVE_START =
  /^(?:compara|busca|revisa|haz|crea|env[ií]a|manda|recu[eé]rdame|ap[uú]ntalo|lee|abre|please|compare|find|check|create|send|remind me|open|read|look up|todo:|tarea:)/i;

const PREFERENCE =
  /(?<![\p{L}\p{N}])(?:prefiero|prefiere|me gusta|le gusta|odio|evito|prefer|prefers|likes?|hates?|always|siempre|nunca|never)(?![\p{L}\p{N}])/iu;
const DECISION =
  /(?<![\p{L}\p{N}])(?:decid[ií]|decidimos|decidi[oó]|acordamos|qued[oó] en|elegimos|vamos a usar|decided|agreed|we will use|we chose|chose)(?![\p{L}\p{N}])/iu;
const COPULA =
  /(?<![\p{L}\p{N}])(?:es|son|est[aá]|est[aá]n|fue|ser[aá]|tiene|tienen|cuesta|vale|usa|usamos|vive|trabaja|corre|corren|is|are|was|will be|has|have|costs|uses|lives|works|runs)(?![\p{L}\p{N}])/iu;
const KEY_VALUE = /^[\p{L}][\p{L}\p{N} _\-/]{1,40}:\s*\S.{0,160}$/u;
const NUMBER_OR_DATE = /\d/;

export function normalizeFact(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u00a0]+/g, " ")
    .trim()
    .replace(/[.;!]+$/u, "")
    .trim();
}

export function factHash(text: string): string {
  return createHash("sha256").update(normalizeFact(text)).digest("hex");
}

export function splitSentences(text: string): string[] {
  return text
    .replace(/\r/g, "")
    .split(/\n+|(?<=[.!?])\s+(?=[\p{Lu}¿¡"«(])/u)
    .map((s) => s.replace(/^[\s\-*•·>]+/u, "").trim())
    .filter(Boolean);
}

function classify(sentence: string): ExtractedFact["kind"] | null {
  const words = sentence.split(/\s+/).length;
  if (words < 3 || sentence.length > 240) return null;
  if (sentence.endsWith("?") || QUESTION_START.test(sentence)) return null;
  if (IMPERATIVE_START.test(sentence)) return null;
  if (REDACTION_MARKERS.test(sentence)) return null;
  if (PREFERENCE.test(sentence)) return "preference";
  if (DECISION.test(sentence)) return "decision";
  if (KEY_VALUE.test(sentence) && NUMBER_OR_DATE.test(sentence)) return "attribute";
  if (COPULA.test(sentence)) return "statement";
  return null;
}

export function extractFacts(...texts: Array<string | null | undefined>): ExtractedFact[] {
  const seen = new Set<string>();
  const out: ExtractedFact[] = [];
  for (const text of texts) {
    if (!text) continue;
    for (const raw of splitSentences(text)) {
      const sentence = raw.replace(/\s+/g, " ").trim();
      const kind = classify(sentence);
      if (!kind) continue;
      const content = sentence.replace(/[.;]+$/u, "");
      const hash = factHash(content);
      if (seen.has(hash)) continue;
      seen.add(hash);
      out.push({ content, content_hash: hash, kind });
      if (out.length >= MAX_FACTS_PER_MOMENT) return out;
    }
  }
  return out;
}
