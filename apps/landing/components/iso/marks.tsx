import * as React from "react";
import { pathOf, type Flat, type KeyMark, type LegendKey, type LineTone, type SolidPaths, type Tone } from "./iso-kit";

interface SolidProps {
  paths: SolidPaths;
  tone?: Tone;
  crease?: Tone | "none";
  halo?: boolean;
  lit?: boolean;
  flat?: boolean;
  className?: string;
  children?: React.ReactNode;
}

export function Solid({ paths, tone = "hi", crease = "faint", halo = false, lit = false, flat = false, className, children }: SolidProps) {
  return (
    <g className={className ? `iso-solid ${className}` : "iso-solid"} data-lit={lit ? "" : undefined} data-seamless={paths.seamless ? "" : undefined}>
      {halo ? <path className="iso-halo" d={paths.fill} /> : null}
      <path className="iso-fill" d={paths.fill} />
      {flat
        ? null
        : paths.shades.map((d, shade) => (d ? <path key={shade} className="iso-shade" data-shade={shade} d={d} /> : null))}
      {flat ? null : <path className="iso-top" d={paths.top} />}
      {crease === "none" || !paths.crease ? null : <path className="iso-line iso-crease" data-tone={crease} d={paths.crease} />}
      {crease === "none" || !paths.bevel ? null : <path className="iso-line iso-bevel" data-tone={crease} d={paths.bevel} />}
      <path className="iso-line iso-edge" data-tone={tone} d={paths.outline} />
      {children}
    </g>
  );
}

interface LineProps {
  d: string;
  tone?: LineTone;
  dotted?: boolean;
  dashed?: boolean;
  className?: string;
  free?: boolean | "start" | "end";
}

export function Line({ d, tone = "lo", dotted = false, dashed = false, className, free }: LineProps) {
  if (!d) return null;
  return (
    <path
      className={className ? `iso-line ${className}` : "iso-line"}
      data-tone={tone}
      data-dotted={dotted ? "" : undefined}
      data-dashed={dashed ? "" : undefined}
      data-free={free === true ? "" : free || undefined}
      d={d}
    />
  );
}

const tenth = (value: number) => Math.round(value * 10) / 10;

export function Wire({ from, to, via = [], tone = "lo" as LineTone }: { from: Flat; to: Flat; via?: Flat[]; tone?: LineTone }) {
  return (
    <g className="iso-wire" data-tone={tone}>
      <Line d={pathOf([from, ...via, to])} tone={tone} />
      <circle className="iso-wire-end" cx={tenth(from[0])} cy={tenth(from[1])} r={1.2} />
      <circle className="iso-wire-end" cx={tenth(to[0])} cy={tenth(to[1])} r={1.2} />
    </g>
  );
}

export function Dots({ points, size = 0.5, tone = "mid" }: { points: Array<Flat | [number, number, number]>; size?: number; tone?: Tone }) {
  return (
    <g className="iso-dots" data-tone={tone}>
      {points.map(([x, y, alpha], index) => (
        <circle key={index} cx={tenth(x)} cy={tenth(y)} r={size} fillOpacity={alpha !== undefined && alpha < 1 ? Math.max(0, alpha) : undefined} />
      ))}
    </g>
  );
}

export function FaceText({
  transform,
  children,
  size = 3,
  tone = "mid",
}: {
  transform: string;
  children: React.ReactNode;
  size?: number;
  tone?: Tone;
}) {
  return (
    <text className="iso-face-text" data-tone={tone} transform={transform} fontSize={size} textAnchor="middle">
      {children}
    </text>
  );
}

function Swatch({ mark }: { mark: KeyMark }) {
  if (mark === "raised" || mark === "flat" || mark === "lit") {
    return (
      <svg className="iso-swatch" data-mark={mark} viewBox="0 0 16 10" aria-hidden="true" focusable="false">
        <path d={mark === "flat" ? "M2 6.5 8 3.5 14 6.5 8 9.5Z" : "M2 4.5 8 1.5 14 4.5 14 6 8 9 2 6Z"} />
        {mark === "flat" ? null : <path className="iso-swatch-crease" d="M2 4.5 8 7.5 14 4.5" />}
      </svg>
    );
  }
  return (
    <svg className="iso-swatch" data-mark={mark} viewBox="0 0 16 10" aria-hidden="true" focusable="false">
      <path d="M1.5 5h13" />
    </svg>
  );
}

export function Plate({
  fig,
  title,
  hint,
  readout,
  keys = [],
  caption,
  children,
}: {
  fig: string;
  title?: string;
  hint?: React.ReactNode;
  readout?: React.ReactNode;
  keys?: LegendKey[];
  caption?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <figure className="iso-figure">
      <div className="iso-plate">
        <div className="iso-plate-corners">
          <span className="iso-plate-corner" data-corner="fig">
            {fig}
          </span>
          {title ? (
            <span className="iso-plate-corner" data-corner="title">
              {title}
            </span>
          ) : null}
          {hint ? (
            <span className="iso-plate-corner" data-corner="hint">
              {hint}
            </span>
          ) : null}
          <span className="iso-plate-corner" data-corner="readout" data-readout="" aria-live="polite">
            {readout}
          </span>
        </div>
        {children}
      </div>
      {keys.length || caption ? (
        <figcaption className="iso-legend">
          {keys.length ? (
            <span className="iso-keys">
              {keys.map((key) => (
                <span className="iso-key" key={key.label}>
                  <Swatch mark={key.mark} />
                  {key.label}
                </span>
              ))}
            </span>
          ) : null}
          {caption ? <span className="iso-caption">{caption}</span> : null}
        </figcaption>
      ) : null}
    </figure>
  );
}
