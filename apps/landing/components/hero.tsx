"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import type { LandingContent } from "../content/types";
import { GridLights } from "./grid-lights";

const StarGlint = dynamic(() => import("./star-glint").then((mod) => mod.StarGlint), {
  ssr: false,
});

const tagClass = ["tag-perceived", "tag-meant", "tag-connects", "tag-todo"] as const;
const tagDepth = [6, -5, 4, -6] as const;

export function Hero({ content }: { content: LandingContent }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const fine = useRef(false);
  const reduce = useRef(true);
  const [glint, setGlint] = useState(false);
  const [glintReady, setGlintReady] = useState(false);
  const onReady = useCallback(() => setGlintReady(true), []);

  useEffect(() => {
    fine.current = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const desktop = window.matchMedia("(min-width: 768px)");
    reduce.current = motion.matches;
    let cancelled = false;
    let idleId = 0;
    let timeoutId = 0;

    const arm = () => {
      window.cancelIdleCallback?.(idleId);
      window.clearTimeout(timeoutId);
      reduce.current = motion.matches;
      const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
      const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
      const blocked =
        motion.matches ||
        !desktop.matches ||
        Boolean(connection?.saveData) ||
        (typeof memory === "number" && memory < 4);
      if (blocked) {
        setGlint(false);
        setGlintReady(false);
        return;
      }
      const start = () => {
        if (!cancelled) setGlint(true);
      };
      if (window.requestIdleCallback) idleId = window.requestIdleCallback(start, { timeout: 2000 });
      else timeoutId = window.setTimeout(start, 1500);
    };

    arm();
    motion.addEventListener("change", arm);
    desktop.addEventListener("change", arm);
    return () => {
      cancelled = true;
      window.cancelIdleCallback?.(idleId);
      window.clearTimeout(timeoutId);
      motion.removeEventListener("change", arm);
      desktop.removeEventListener("change", arm);
    };
  }, []);

  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!fine.current || reduce.current) return;
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const dx = (event.clientX - rect.left) / rect.width - 0.5;
    const dy = (event.clientY - rect.top) / rect.height - 0.5;
    stage.querySelectorAll<HTMLElement>("[data-depth]").forEach((tag) => {
      const depth = Number(tag.dataset.depth);
      tag.style.transform = `translate(${(dx * depth).toFixed(2)}px, ${(dy * depth).toFixed(2)}px)`;
    });
  };

  const leave = () => {
    stageRef.current?.querySelectorAll<HTMLElement>("[data-depth]").forEach((tag) => {
      tag.style.transform = "translate(0px, 0px)";
    });
  };

  const { hero, actions } = content;

  return (
    <section className="hero">
      <div className="grid-bg" aria-hidden="true">
        <GridLights />
      </div>
      <div className="hero-copy">
        <p className="eyebrow">{hero.eyebrow}</p>
        <h1>
          <span className="hero-line">{hero.lines[0]}</span>
          <span className="hero-line">{hero.lines[1]}</span>
        </h1>
      </div>
      <div className="hero-stage" ref={stageRef} onPointerMove={move} onPointerLeave={leave}>
        <div className={glintReady ? "mark is-gl" : "mark"} aria-hidden="true">
          <div className="halo" />
          <svg className="mark-svg" viewBox="0 0 100 100">
            <g className="bracket-l">
              <path d="M24 12H10v76h14" fill="none" stroke="currentColor" strokeWidth="6.5" />
            </g>
            <g className="bracket-r">
              <path d="M76 12h14v76H76" fill="none" stroke="currentColor" strokeWidth="6.5" />
            </g>
            <g className="star-g">
              <path
                className="star-fill"
                d="M50 20Q50 50 80 50Q50 50 50 80Q50 50 20 50Q50 50 50 20z"
                fill="currentColor"
              />
              <circle cx="68" cy="30" r="5" fill="#A1A1A1" />
            </g>
          </svg>
          {glint ? <StarGlint onReady={onReady} /> : null}
        </div>
        {hero.tags.map((tag, index) => (
          <span key={tag} className={`tag ${tagClass[index]}`} data-depth={tagDepth[index]}>
            <span className="tag-label">{tag}</span>
          </span>
        ))}
      </div>
      <p className="hero-sub">
        <span className="hero-lede">{hero.lede}</span>
        <span className="hero-promise">{hero.promise}</span>
      </p>
      <div className="hero-actions">
        <a className="btn btn-primary" href="#manifesto">
          {actions.readManifesto}
        </a>
        <a className="btn btn-secondary" href="#sdk">
          {actions.docs}
        </a>
      </div>
    </section>
  );
}
