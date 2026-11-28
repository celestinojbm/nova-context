"use client";

import ScrollReveal from "@/components/react-bits/ScrollReveal";

/** Section title only. The hero h1 stays a static heading so it does not move. */
export function SectionHeading({ children }: { children: string }) {
  return (
    <ScrollReveal
      containerClassName="section-title"
      textClassName="block"
      baseRotation={0}
      baseOffset={0}
      baseOpacity={0.62}
      enableBlur={false}
      blurStrength={0}
      effect="fade"
      mode="enter"
      splitBy="words"
      duration={0.7}
      stagger={0.035}
    >
      {children}
    </ScrollReveal>
  );
}
