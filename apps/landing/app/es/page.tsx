import type { Metadata } from "next";
import { Landing } from "../../components/landing";
import { es } from "../../content/es";

export const metadata: Metadata = {
  title: es.meta.title,
  description: es.meta.description,
  alternates: {
    canonical: "/es",
    languages: {
      en: "/",
      es: "/es",
      "x-default": "/",
    },
  },
};

export default function Page() {
  return <Landing content={es} />;
}
