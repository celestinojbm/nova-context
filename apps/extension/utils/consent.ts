import {
  CONSENT_VERSION,
  consentValid,
  makeConsent,
  type ConsentRecord,
} from "@nova/context-engine";

/** chrome.storage-backed consent record; logic lives in @nova/context-engine. */
const KEY = "consent";

export async function getConsent(): Promise<ConsentRecord | null> {
  const stored = await chrome.storage.local.get(KEY);
  return (stored[KEY] as ConsentRecord | undefined) ?? null;
}

export async function hasValidConsent(): Promise<boolean> {
  return consentValid(await getConsent(), CONSENT_VERSION);
}

export async function acceptConsent(): Promise<ConsentRecord> {
  const record = makeConsent();
  await chrome.storage.local.set({ [KEY]: record });
  return record;
}

export async function resetConsent(): Promise<void> {
  await chrome.storage.local.remove(KEY);
}
