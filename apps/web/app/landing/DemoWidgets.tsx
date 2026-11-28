"use client";

import { useState } from "react";
import PromptBar from "./react-bits/PromptBar";
import ThoughtLine from "./react-bits/ThoughtLine";
import type { LandingCopy } from "./copy";

export default function DemoWidgets({ copy }: { copy: LandingCopy }) {
  const [sent, setSent] = useState<string | null>(null);
  const excerpt = sent ? (sent.length > 72 ? `${sent.slice(0, 69)}…` : sent) : null;
  const steps = excerpt ? copy.sentSteps(excerpt) : copy.traceSteps;

  return (
    <div className="landing-demo-body">
      <ThoughtLine
        key={excerpt ?? "preview"}
        label={excerpt ? copy.sentLabel : copy.traceLabel}
        doneLabel={excerpt ? copy.sentDone : copy.traceDone}
        steps={steps}
        working
        settleAfter={2.8}
        collapseOnSettle={false}
        shimmer={false}
        fontSize={14}
        color="var(--ink)"
        glyphColor="var(--ink)"
      />
      <PromptBar
        className="landing-prompt"
        placeholder={copy.placeholder}
        background="var(--bg)"
        color="var(--ink)"
        menuBackground="var(--bg)"
        sparkColor="var(--ink)"
        sparkBoost={0}
        width={608}
        radius={10}
        sources={[
          { key: "page", name: copy.sourcePage, description: copy.sourcePageHint },
          { key: "project", name: copy.sourceProject, description: copy.sourceProjectHint },
          { key: "memory", name: copy.sourceMemory, description: copy.sourceMemoryHint },
        ]}
        commands={[
          { key: "save", name: "/save", description: copy.commandSave },
          { key: "link", name: "/link", description: copy.commandLink },
          { key: "task", name: "/task", description: copy.commandTask },
          { key: "recall", name: "/recall", description: copy.commandRecall },
        ]}
        models={[
          { key: "device", name: copy.modelDevice },
          { key: "cloud", name: copy.modelCloud },
        ]}
        defaultModel="device"
        efforts={copy.efforts}
        onSend={(text) => {
          const trimmed = text.trim();
          if (trimmed) setSent(trimmed);
        }}
      />
    </div>
  );
}
