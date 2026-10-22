import { Plate } from "../../iso/marks";
import { CaptureDrawing } from "./drawing";
import { CAPTION, CAPTURE_KEYS, HEIGHT, REST_VISUAL, WIDTH } from "./geometry";
import { REST_READOUT } from "./model";

export function CapturePoster() {
  return (
    <div className="iso" data-theme="light">
      <Plate
        fig="Fig 1"
        title="Banco de captura"
        hint="Mantén para hablar · pulsa el perno"
        readout={REST_READOUT}
        keys={CAPTURE_KEYS}
        caption={CAPTION}
      >
        <svg className="iso-svg" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Banco de captura en reposo" focusable="false">
          <CaptureDrawing visual={REST_VISUAL} />
        </svg>
      </Plate>
    </div>
  );
}
