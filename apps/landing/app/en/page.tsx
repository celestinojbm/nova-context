import type { Metadata } from "next";
import { LandingPage } from "@/components/landing-page";
import { en } from "@/content/en";

export const metadata: Metadata = {
  title: en.meta.title,
  description: en.meta.description,
  alternates: {
    canonical: "/en",
    languages: { es: "/", en: "/en", "x-default": "/" },
  },
};

export default function Page() {
  return <LandingPage copy={en} />;
}
