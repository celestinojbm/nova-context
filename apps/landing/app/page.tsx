import type { Metadata } from "next";
import { Landing } from "../components/landing";
import { en } from "../content/en";

export const metadata: Metadata = {
  title: en.meta.title,
  description: en.meta.description,
  alternates: {
    canonical: "/",
    languages: {
      en: "/",
      es: "/es",
      "x-default": "/",
    },
  },
};

export default function Page() {
  return <Landing content={en} />;
}
