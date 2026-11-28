"use client";

import { useState } from "react";
import PromptBar from "@/components/react-bits/PromptBar";
import ThoughtLine from "@/components/react-bits/ThoughtLine";
import type { LandingCopy } from "@/content/types";

type DemoCopy = LandingCopy["demo"];

export function HeroDemo({ copy }: { copy: DemoCopy }) {
  const [phase, setPhase] = useState<"idle" | "working" | "settled">("idle");

  return (
    <div className="hero-demo w-full max-w-xl border border-white/10 bg-black p-4 text-left sm:p-5">
      <p className="font-mono text-sm tracking-[0.08em] text-[#A1A1A1] uppercase">{copy.kicker}</p>
      <p className="mt-2 text-base leading-relaxed text-[#A1A1A1]">{copy.note}</p>
      <p className="mt-1 text-sm text-[#8F8F8F]">{copy.hint}</p>
      <div className="mt-4 max-w-full">
        <PromptBar
          placeholder={copy.placeholder}
          sources={copy.sources.map((source) => ({
            ...source,
            icon: <span className="block h-1.5 w-1.5 rounded-full bg-current" />,
          }))}
          commands={[...copy.commands]}
          models={[]}
          efforts={[]}
          background="#0a0a0a"
          color="#ededed"
          menuBackground="#141414"
          sparkColor="#ededed"
          radius={6}
          width={560}
          copy={copy.prompt}
          busy={phase === "working"}
          onSend={() => setPhase("working")}
          onStop={() => setPhase("idle")}
        />
      </div>
      <div className="mt-4 max-w-full overflow-x-auto">
        {phase === "idle" ? (
          <p className="text-sm text-[#8F8F8F]">{copy.idle}</p>
        ) : (
          <ThoughtLine
            label={copy.thinking}
            doneLabel={copy.done}
            steps={[...copy.steps]}
            working={phase === "working"}
            settleAfter={2.2}
            showTimer={false}
            shimmer={false}
            glyph="dot"
            color="#a1a1a1"
            glyphColor="#ededed"
            fontSize={16}
            onSettle={() => setPhase((current) => (current === "working" ? "settled" : current))}
          />
        )}
      </div>
    </div>
  );
}
