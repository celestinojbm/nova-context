/**
 * First-run consent (M4). The extension blocks capture and live mode until
 * the user has accepted the CURRENT consent version; bumping the version
 * (because disclosures materially changed) re-triggers onboarding. Pure
 * logic here so the gate is unit-testable; storage lives in the extension.
 */

export const CONSENT_VERSION = 1;

export interface ConsentRecord {
  version: number;
  accepted_at: string; // ISO timestamp
}

export function consentValid(
  record: ConsentRecord | null | undefined,
  currentVersion: number = CONSENT_VERSION,
): boolean {
  if (!record) return false;
  if (typeof record.version !== "number" || record.version < currentVersion) return false;
  return Number.isFinite(Date.parse(record.accepted_at));
}

export function makeConsent(now: Date = new Date()): ConsentRecord {
  return { version: CONSENT_VERSION, accepted_at: now.toISOString() };
}

/** The disclosures shown at onboarding. One source of truth so the UI and
 * any future consent receipt render the same text. */
export const CONSENT_POINTS: Array<{ title: string; body: string }> = [
  {
    title: "Nova captures only when you ask",
    body: "Capture happens when you click Capture or start a live session. There is no background recording, no silent capture, ever.",
  },
  {
    title: "Instant Capture Mode",
    body: "Captures the visible tab (screenshot + page text) plus your spoken or typed instruction, and saves it as a Context Moment.",
  },
  {
    title: "Live Context Mode",
    body: "While a session is running (red indicator, 30-minute limit), Nova samples frames and page text into a temporary buffer on this device. The buffer is destroyed when the session ends. Only moments you explicitly save are stored.",
  },
  {
    title: "What is stored permanently",
    body: "Saved Context Moments (screenshot, extracted text, your instruction), tasks, actions, and an audit log of events. You can export or delete everything from the web app.",
  },
  {
    title: "What may go to cloud providers",
    body: "Only if configured by you/your admin: voice clips for transcription, instruction + page text for enrichment, and live-session slices for answers. Each has an explicit off switch; audio is never stored.",
  },
  {
    title: "Redaction — and its limits",
    body: "Obvious sensitive text (emails, phone numbers, card numbers, API keys, SSNs, IBANs) is redacted before anything is stored or sent to a model. IMPORTANT: redaction covers text only — pixels inside screenshots and live frames are NOT redacted. You can disable screenshots or blur them in Settings.",
  },
];
