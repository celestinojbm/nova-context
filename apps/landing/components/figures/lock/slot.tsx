"use client";

import dynamic from "next/dynamic";
import { LockPoster } from "./poster";

const LockInteractive = dynamic(() => import("./interactive"), {
  ssr: false,
  loading: () => <LockPoster />,
});

export function LockSlot() {
  return <LockInteractive />;
}
