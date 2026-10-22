"use client";

import { useEffect, useRef, useState } from "react";

type Cell = { x: number; y: number; id: number };

/**
 * At most six cells of the 80px grid light up to #111. Static when the
 * user prefers reduced motion.
 */
export function GridLights() {
  const ref = useRef<HTMLDivElement>(null);
  const [cells, setCells] = useState<Cell[]>([]);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    const root = ref.current?.parentElement;
    if (!root) return;
    let seq = 0;
    const tick = () => {
      const cols = Math.max(1, Math.ceil(root.clientWidth / 80));
      const rows = Math.max(1, Math.ceil(root.clientHeight / 80));
      const next: Cell[] = [];
      for (let i = 0; i < 6; i += 1) {
        next.push({
          x: Math.floor(Math.random() * cols),
          y: Math.floor(Math.random() * rows),
          id: seq,
        });
        seq += 1;
      }
      setCells(next);
    };
    tick();
    const id = window.setInterval(tick, 2600);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div ref={ref} className="grid-lights" aria-hidden="true">
      {cells.map((cell) => (
        <span key={cell.id} style={{ left: cell.x * 80, top: cell.y * 80 }} />
      ))}
    </div>
  );
}
