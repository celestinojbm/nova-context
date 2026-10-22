import type * as React from "react";
import { Dots, FaceText, Line, Solid } from "../../iso/marks";
import { ART, LABEL, type LockVisual } from "./geometry";

export function LockDrawing({
  visual,
  onDrawer,
  onKey,
}: {
  visual: LockVisual;
  onDrawer?: () => void;
  onKey?: () => void;
}) {
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
      <Solid paths={ART.plinth} tone="lo" />
      <Solid paths={ART.back} tone="mid" />
      <Solid paths={ART.left} tone="mid" />
      <Solid paths={ART.right} tone="mid" />
      <Solid paths={ART.top} tone="mid" />
      <Line d={ART.groove} tone="lo" />
      <Line d={ART.screwRings} tone="lo" />
      <Dots points={ART.screws} size={0.48} tone="mid" />
      <Solid paths={ART.plate} tone="lo" crease="none" />
      <Line d={ART.plateRules} tone="lo" free />
      <g data-part="key-stem" transform={visual.key}>
        <Solid paths={ART.stem} tone="mid" crease="none" />
        <Solid paths={ART.bit} tone="hi" />
      </g>
      <Solid paths={ART.rose} tone="mid" />
      <Solid paths={ART.roseLip} tone="lo" />
      <Line d={ART.roseBore} tone="lo" />
      <Dots points={ART.grille} size={0.38} tone="lo" />
      <Solid paths={ART.shelf} tone="lo" />
      <Solid paths={ART.stile} tone="mid" />
      <Solid paths={ART.chuteFloor} tone="lo" flat crease="none" />
      {ART.chuteCheeks.map((paths, index) => (
        <Solid key={`cheek-${index}`} paths={paths} tone="mid" />
      ))}
      <g data-part="card" transform={visual.card}>
        <Solid paths={ART.egress} tone="hi" lit={visual.egressLit} />
        <Line d={ART.egressRules} tone="mid" free />
      </g>
      <g data-part="door" transform={visual.door}>
        <Solid paths={ART.door} tone="mid" />
        <Line d={ART.doorSeam} tone="lo" />
      </g>
      <Solid paths={ART.lintel} tone="mid" />
      <Solid paths={ART.boltGuide} tone="lo" />
      <g data-part="bolt" transform={visual.bolt}>
        <Solid paths={ART.bolt} tone="hi" />
      </g>
      <Solid paths={ART.lowerFront} tone="mid" />
      <Solid paths={ART.lowerPull} tone="lo" />
      <g
        data-part="drawer"
        transform={visual.drawer}
        onPointerDown={onDrawer}
        style={onDrawer ? { cursor: "pointer" } : undefined}
      >
        {ART.boxSides.map((paths, index) => (
          <Solid key={`side-${index}`} paths={paths} tone="lo" />
        ))}
        <Solid paths={ART.boxFloor} tone="lo" flat crease="none" />
        <Solid paths={ART.innerCard} tone="hi" flat crease="none" />
        <Line d={ART.innerRules} tone="mid" free />
        <Solid paths={ART.midFront} tone="mid" />
        <Line d={ART.midMark} tone="mid" dotted />
        <Solid paths={ART.midPull} tone="hi" />
      </g>
      <Solid paths={ART.upperFront} tone="mid" />
      <Solid paths={ART.upperPull} tone="lo" />
      {ART.hinge.map((paths, index) => (
        <Solid key={`hinge-${index}`} paths={paths} tone="lo" crease="none" />
      ))}
      <g
        data-part="key-bow"
        transform={visual.key}
        onPointerDown={onKey}
        style={onKey ? { cursor: "pointer", touchAction: "none" } : undefined}
      >
        <Solid paths={ART.bow} tone="hi" />
        <Line d={ART.keyKnurl} tone="lo" />
        <Line d={ART.bowHole} tone="mid" />
      </g>
      <FaceText transform={LABEL} size={3} tone="mid">
        SALIDA
      </FaceText>
    </>
  );
}
