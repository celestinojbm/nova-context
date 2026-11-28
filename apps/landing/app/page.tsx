import type { Metadata } from "next";
import { LandingPage } from "@/components/landing-page";
import { es } from "@/content/es";

export const metadata: Metadata = {
  title: es.meta.title,
  description: es.meta.description,
  alternates: {
    canonical: "/",
    languages: { es: "/", en: "/en", "x-default": "/" },
  },
};

export default function Page() {
  return <LandingPage copy={es} />;
}
