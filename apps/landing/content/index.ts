import { en } from "./en";
import { es } from "./es";
import type { LandingContent, Locale } from "./types";

export const defaultLocale: Locale = "en";
export const locales = ["en", "es"] as const;

const dictionaries: Record<Locale, LandingContent> = { en, es };

export function getContent(locale: Locale): LandingContent {
  return dictionaries[locale] ?? dictionaries.en;
}

export { en, es };
