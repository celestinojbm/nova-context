"use client";

import dynamic from "next/dynamic";
import type { LandingCopy } from "@/content/types";

const HeroDemo = dynamic(() => import("./hero-demo").then((mod) => mod.HeroDemo), {
  ssr: false,
});

/** PromptBar draws on a canvas. Keep that tree off the server. */
export function HeroDemoSlot({ copy }: { copy: LandingCopy["demo"] }) {
  return (
    <div className="w-full max-w-xl min-h-[240px]">
      <HeroDemo copy={copy} />
    </div>
  );
}
