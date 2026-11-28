"use client";

import * as React from "react";
import { Plate } from "../../iso/marks";
import { asksForStillness, follow, useInView, useReadout } from "../../iso/live";
import { CaptureDrawing } from "./drawing";
import { CAPTION, CAPTURE_KEYS, HEIGHT, REST_VISUAL, WIDTH, visualOf } from "./geometry";
import { REST_POSE, REST_READOUT, readoutOf, stepCapture, tourAt, type CaptureInput, type CapturePose } from "./model";

function paint(scope: HTMLElement | null, pose: CapturePose, say: (text: string) => void) {
  if (!scope) return;
  const visual = visualOf(pose);
  const group = (name: string, transform: string) => scope.querySelector(`[data-part="${name}"]`)?.setAttribute("transform", transform);
  group("stem", visual.plunger);
  group("cap", visual.plunger);
  group("stamp", visual.stamp);
  group("bolt", visual.bolt);
  group("card", visual.card);
  scope.querySelector('[data-part="needle"]')?.setAttribute("d", visual.needle);
  scope.querySelector('[data-part="coil-back"]')?.setAttribute("d", visual.coilBack);
  scope.querySelector('[data-part="coil-front"]')?.setAttribute("d", visual.coilFront);
  scope.querySelector('[data-part="glass"] .iso-solid')?.toggleAttribute("data-lit", visual.glassLit);
  scope.querySelector('[data-part="die"] .iso-solid')?.toggleAttribute("data-lit", visual.dieLit);
  say(readoutOf(pose));
}

export default function CaptureInteractive() {
  const { anchor, say } = useReadout<HTMLDivElement>();
  const inView = useInView(anchor);
  const pose = React.useRef<CapturePose>({ ...REST_POSE });
  const input = React.useRef<CaptureInput>({ talk: 0, arm: 0, seen: 0, said: false });
  const touched = React.useRef(false);
  const clock = React.useRef(0);
  const sayRef = React.useRef(say);
  sayRef.current = say;

  const settle = React.useCallback(() => {
    if (!asksForStillness()) return;
    for (let step = 0; step < 6; step += 1) {
      pose.current = stepCapture(pose.current, input.current, 1, true, follow);
    }
    paint(anchor.current, pose.current, sayRef.current);
  }, [anchor]);

  React.useEffect(() => {
    let frame = 0;
    let last = 0;
    const tick = (now: number) => {
      const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
      last = now;
      const calm = asksForStillness();
      const touring = !touched.current && !calm;
      const desired = touring ? tourAt(clock.current) : input.current;
      if (touring) clock.current += dt;
      pose.current = stepCapture(pose.current, desired, dt, calm, follow);
      paint(anchor.current, pose.current, sayRef.current);
      frame = requestAnimationFrame(tick);
    };
    if (inView && !asksForStillness()) frame = requestAnimationFrame(tick);
    else paint(anchor.current, pose.current, sayRef.current);
    return () => cancelAnimationFrame(frame);
  }, [anchor, inView]);

  const mark = () => {
    touched.current = true;
  };

  return (
    <div className="iso">
      <Plate
        fig="Fig 1"
        title="Banco de captura"
        hint="Mantén para hablar · pulsa el perno"
        readout={REST_READOUT}
        keys={CAPTURE_KEYS}
        caption={CAPTION}
      >
        <div
          ref={anchor}
          tabIndex={0}
          role="application"
          aria-label="Banco de captura. Mantén espacio para hablar, intro mueve el perno y escape vuelve al reposo."
          onKeyDown={(event) => {
            if (event.key === " " && !event.repeat) {
              event.preventDefault();
              mark();
              input.current.talk = 1;
              input.current.said = true;
              settle();
            }
            if (event.key === "Enter") {
              event.preventDefault();
              mark();
              input.current.arm = input.current.arm > 0.5 ? 0 : 1;
              settle();
            }
            if (event.key === "Escape") {
              mark();
              input.current = { talk: 0, arm: 0, seen: 0, said: false };
              settle();
            }
          }}
          onKeyUp={(event) => {
            if (event.key === " ") {
              input.current.talk = 0;
              settle();
            }
          }}
          onPointerLeave={() => {
            input.current.seen = 0;
            input.current.talk = 0;
            settle();
          }}
        >
          <svg className="iso-svg" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Banco de captura" focusable="false">
            <CaptureDrawing
              visual={REST_VISUAL}
              bind={{
                onGlass: () => {
                  mark();
                  input.current.seen = 1;
                  settle();
                },
                onTalkStart: () => {
                  mark();
                  input.current.talk = 1;
                  input.current.said = true;
                  input.current.seen = 1;
                  settle();
                },
                onTalkEnd: () => {
                  input.current.talk = 0;
                  settle();
                },
                onBolt: () => {
                  mark();
                  input.current.arm = input.current.arm > 0.5 ? 0 : 1;
                  settle();
                },
              }}
            />
          </svg>
        </div>
      </Plate>
    </div>
  );
}
