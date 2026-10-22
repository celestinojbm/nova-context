"use client";

import dynamic from "next/dynamic";
import { CapturePoster } from "./poster";

const CaptureInteractive = dynamic(() => import("./interactive"), {
  ssr: false,
  loading: () => <CapturePoster />,
});

export function CaptureSlot() {
  return <CaptureInteractive />;
}
