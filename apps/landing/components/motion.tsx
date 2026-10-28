"use client";

import { LazyMotion, MotionConfig, domAnimation, m } from "framer-motion";
import type { ReactNode } from "react";

const easeOut = [0.16, 1, 0.3, 1] as const;

export function MotionRoot({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}

/** Below-the-fold entrance. Transform only, once. Reduced motion is a 120ms fade. */
export function Reveal({ children }: { children: ReactNode }) {
  return (
    <m.div
      className="reveal"
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "0px 0px -10% 0px" }}
      transition={{ duration: 0.48, ease: easeOut }}
    >
      {children}
    </m.div>
  );
}
