import type * as React from "react";
import { Dots, Line, Solid, Wire } from "../../iso/marks";
import { ART, type CaptureVisual } from "./geometry";

export interface CaptureBind {
  glass?: React.Ref<SVGGElement>;
  die?: React.Ref<SVGGElement>;
  stem?: React.Ref<SVGGElement>;
  cap?: React.Ref<SVGGElement>;
  stamp?: React.Ref<SVGGElement>;
  bolt?: React.Ref<SVGGElement>;
  card?: React.Ref<SVGGElement>;
  needle?: React.Ref<SVGPathElement>;
  coilBack?: React.Ref<SVGPathElement>;
  coilFront?: React.Ref<SVGPathElement>;
  onGlass?: () => void;
  onTalkStart?: () => void;
  onTalkEnd?: () => void;
  onBolt?: () => void;
}

export function CaptureDrawing({ visual, bind }: { visual: CaptureVisual; bind?: CaptureBind }) {
  const talk = bind?.onTalkStart
    ? {
        onPointerDown: (event: React.PointerEvent) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          bind.onTalkStart?.();
        },
        onPointerUp: () => bind.onTalkEnd?.(),
        onPointerCancel: () => bind.onTalkEnd?.(),
      }
    : {};
  return (
    <>
      <path className="iso-halo" d={ART.halo} />
      {ART.feet.map((parts, index) => (
        <g key={`foot-${index}`}>
          {parts.map((paths, part) => (
            <Solid key={part} paths={paths} tone={part ? "mid" : "lo"} />
          ))}
        </g>
      ))}
      <Solid paths={ART.base} tone="mid" />
      <Line d={ART.groove} tone="lo" />
      <Line d={ART.screwRings} tone="lo" />
      <Dots points={ART.screws} size={0.5} tone="mid" />
      <Line d={ART.ticksMinor} tone="lo" />
      <Line d={ART.ticksMajor} tone="mid" />
      <Solid paths={ART.plate} tone="lo" crease="none" />
      <Line d={ART.plateLine} tone="faint" />
      <Line d={ART.plateRules} tone="lo" free />
      <Dots points={ART.plateScrews} size={0.42} tone="mid" />
      {ART.cheeks.map((paths, index) => (
        <Solid key={`cheek-${index}`} paths={paths} tone="mid" />
      ))}
      <Solid paths={ART.bridge} tone="mid" />
      <Solid paths={ART.lampFoot} tone="lo" />
      <Solid paths={ART.lampStem} tone="mid" crease="none" />
      <Solid paths={ART.lampNeck} tone="mid" />
      <Solid paths={ART.lampHead} tone="mid" />
      <Solid paths={ART.lampShade} tone="lo" />
      <Solid paths={ART.lampCap} tone="mid" />
      <Solid paths={ART.vialFoot} tone="lo" />
      <Solid paths={ART.vial} tone="hi" />
      <Solid paths={ART.vialCap} tone="mid" />
      <Line d={ART.vialMark} tone="mid" dotted />
      {ART.posts.map((paths, index) => (
        <Solid key={`post-${index}`} paths={paths} tone="mid" />
      ))}
      <Solid paths={ART.bezel} tone="mid" />
      <g data-part="glass" ref={bind?.glass} onPointerEnter={bind?.onGlass} style={bind?.onGlass ? { cursor: "pointer" } : undefined}>
        <Solid paths={ART.glass} tone="hi" lit={visual.glassLit} />
        <Line d={ART.glassRules} tone="mid" free />
      </g>
      {ART.clips.map((paths, index) => (
        <Solid key={`clip-${index}`} paths={paths} tone="lo" crease="none" />
      ))}
      <Solid paths={ART.anvil} tone="mid" />
      <Solid paths={ART.sheet} tone="lo" flat crease="none" />
      {ART.collar.map((paths, index) => (
        <Solid key={`collar-${index}`} paths={paths} tone="lo" />
      ))}
      <path data-part="coil-back" ref={bind?.coilBack} className="iso-line" data-tone="mid" d={visual.coilBack} />
      {ART.rods.map((paths, index) => (
        <Solid key={`rod-${index}`} paths={paths} tone="mid" crease="none" />
      ))}
      <Line d={ART.rodTops.join("")} tone="lo" />
      <g data-part="stem" ref={bind?.stem} transform={visual.plunger}>
        <Solid paths={ART.stem} tone="mid" crease="none" />
      </g>
      <Solid paths={ART.micPlinth} tone="lo" />
      <Solid paths={ART.micColumn} tone="mid" crease="none" />
      <Solid paths={ART.head} tone="mid" />
      <Line d={ART.headBore} tone="lo" />
      <g data-part="cap" ref={bind?.cap} transform={visual.plunger} style={bind?.onTalkStart ? { cursor: "pointer", touchAction: "none" } : undefined} {...talk}>
        <Solid paths={ART.cap} tone="hi" />
        <Line d={ART.capKnurl} tone="lo" />
        <Dots points={ART.grille} size={0.45} tone="mid" />
      </g>
      <g data-part="stamp" ref={bind?.stamp} transform={visual.stamp}>
        {ART.bushes.map((paths, index) => (
          <Solid key={`bush-${index}`} paths={paths} tone="mid" />
        ))}
        <Solid paths={ART.stamp} tone="hi" />
        <g data-part="die" ref={bind?.die}>
          <Solid paths={ART.die} tone="hi" lit={visual.dieLit} />
        </g>
      </g>
      <path data-part="coil-front" ref={bind?.coilFront} className="iso-line" data-tone="mid" d={visual.coilFront} />
      <Solid paths={ART.boltBed} tone="lo" />
      <g
        data-part="bolt"
        ref={bind?.bolt}
        transform={visual.bolt}
        onPointerDown={bind?.onBolt}
        style={bind?.onBolt ? { cursor: "pointer" } : undefined}
      >
        <Solid paths={ART.bolt} tone="mid" />
        <Solid paths={ART.thumb} tone="hi" />
        <Line d={ART.thumbKnurl} tone="lo" />
      </g>
      <Solid paths={ART.trayWalls[1]!} tone="mid" />
      <Solid paths={ART.trayFloor} tone="lo" flat crease="none" />
      <g data-part="card" ref={bind?.card} transform={visual.card}>
        <Solid paths={ART.card} tone="hi" flat crease="none" />
        <Line d={ART.cardRules} tone="mid" free />
      </g>
      <Solid paths={ART.trayWalls[2]!} tone="mid" />
      <Solid paths={ART.trayWalls[3]!} tone="mid" />
      <Solid paths={ART.trayWalls[0]!} tone="mid" />
      <Solid paths={ART.dial} tone="mid" />
      <Solid paths={ART.dialLip} tone="lo" />
      <Line d={ART.dialFace} tone="faint" />
      <Line d={ART.dialTicksMinor} tone="lo" />
      <Line d={ART.dialTicksMajor} tone="hi" />
      <path data-part="needle" ref={bind?.needle} className="iso-line" data-tone="lit" d={visual.needle} data-free="end" />
      <Solid paths={ART.hub} tone="hi" crease="none" />
      {ART.boots.map((paths, index) => (
        <Solid key={`boot-${index}`} paths={paths} tone="lo" />
      ))}
      <Wire from={ART.cableFrom} to={ART.cableTo} via={ART.cableVia} tone="lo" />
    </>
  );
}
