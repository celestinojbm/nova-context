import { Plate } from "../../iso/marks";
import { LockDrawing } from "./drawing";
import { HEIGHT, LOCK_CAPTION, LOCK_KEYS, REST_LOCK_VISUAL, WIDTH } from "./geometry";
import { REST_LOCK_READOUT } from "./model";

export function LockPoster() {
  return (
    <div className="iso" data-theme="light">
      <Plate fig="Fig 2" title="Caja de salida" hint="Abre el cajón · mete la llave" readout={REST_LOCK_READOUT} keys={LOCK_KEYS} caption={LOCK_CAPTION}>
        <svg className="iso-svg" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Caja de salida en reposo" focusable="false">
          <LockDrawing visual={REST_LOCK_VISUAL} />
        </svg>
      </Plate>
    </div>
  );
}
