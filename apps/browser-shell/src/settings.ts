import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_SETTINGS, type ShellSettings } from "./api-client.js";

/**
 * Settings persistence for the shell (device token, API URL, capture prefs).
 * Stored as a 0600 JSON file under Electron's userData directory — the same
 * trust level as the extension's chrome.storage.local (protected by OS user
 * account permissions, not encrypted at rest; see the threat model in
 * docs/NOVA_BROWSER.md). Captured content is NEVER written here or anywhere
 * else on disk by the shell.
 */

export function loadSettingsFile(file: string): ShellSettings {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<ShellSettings>;
    return {
      ...DEFAULT_SETTINGS,
      ...(typeof raw === "object" && raw !== null ? raw : {}),
      captureMode: raw.captureMode === "text_only" ? "text_only" : "full",
      strictRedaction: raw.strictRedaction !== false,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettingsFile(file: string, settings: ShellSettings): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2), { mode: 0o600 });
}
