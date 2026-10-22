"use client";

import * as React from "react";
import { Plate } from "../../iso/marks";
import { asksForStillness, follow, useInView, useReadout } from "../../iso/live";
import { LockDrawing } from "./drawing";
import { HEIGHT, LOCK_CAPTION, LOCK_KEYS, REST_LOCK_VISUAL, WIDTH, lockVisual } from "./geometry";
import { REST_LOCK, REST_LOCK_READOUT, lockReadout, lockTour, stepLock, type LockInput, type LockPose } from "./model";

function paint(scope: HTMLElement | null, pose: LockPose, say: (text: string) => void) {
  if (!scope) return;
  const visual = lockVisual(pose);
  const group = (name: string, transform: string) => scope.querySelector(`[data-part="${name}"]`)?.setAttribute("transform", transform);
  group("drawer", visual.drawer);
  group("key-stem", visual.key);
  group("key-bow", visual.key);
  group("bolt", visual.bolt);
  group("door", visual.door);
  group("card", visual.card);
  scope.querySelector('[data-part="card"] .iso-solid')?.toggleAttribute("data-lit", visual.egressLit);
  say(lockReadout(pose));
}

export default function LockInteractive() {
  const { anchor, say } = useReadout<HTMLDivElement>();
  const inView = useInView(anchor);
  const pose = React.useRef<LockPose>({ ...REST_LOCK });
  const input = React.useRef<LockInput>({ drawer: 0, key: 0 });
  const touched = React.useRef(false);
  const clock = React.useRef(0);
  const sayRef = React.useRef(say);
  sayRef.current = say;

  const settle = React.useCallback(() => {
    if (!asksForStillness()) return;
    for (let step = 0; step < 6; step += 1) pose.current = stepLock(pose.current, input.current, 1, true, follow);
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
      const desired = touring ? lockTour(clock.current) : input.current;
      if (touring) clock.current += dt;
      pose.current = stepLock(pose.current, desired, dt, calm, follow);
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
      <Plate fig="Fig 2" title="Caja de salida" hint="Abre el cajón · mete la llave" readout={REST_LOCK_READOUT} keys={LOCK_KEYS} caption={LOCK_CAPTION}>
        <div
          ref={anchor}
          tabIndex={0}
          role="application"
          aria-label="Caja de salida. Flecha abajo abre el cajón del proyecto, intro mete o saca la llave, escape vuelve al reposo."
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              mark();
              input.current.drawer = event.key === "ArrowDown" ? 1 : 0;
              settle();
            }
            if (event.key === "Enter") {
              event.preventDefault();
              mark();
              input.current.key = input.current.key > 0.5 ? 0 : 1;
              settle();
            }
            if (event.key === "Escape") {
              mark();
              input.current = { drawer: 0, key: 0 };
              settle();
            }
          }}
        >
          <svg className="iso-svg" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Caja de salida" focusable="false">
            <LockDrawing
              visual={REST_LOCK_VISUAL}
              onDrawer={() => {
                mark();
                input.current.drawer = input.current.drawer > 0.5 ? 0 : 1;
                settle();
              }}
              onKey={() => {
                mark();
                input.current.key = input.current.key > 0.5 ? 0 : 1;
                settle();
              }}
            />
          </svg>
        </div>
      </Plate>
    </div>
  );
}
