/** Modelo del banco de captura. Las fases salen de las mismas piezas que se mueven. */

export interface CapturePose {
  talk: number;
  arm: number;
  stamp: number;
  card: number;
  seen: number;
  said: boolean;
}

export interface CaptureInput {
  talk: number;
  arm: number;
  seen: number;
  said: boolean;
}

export const REST_POSE: CapturePose = {
  talk: 0,
  arm: 0,
  stamp: 0,
  card: 0,
  seen: 0,
  said: false,
};

export const REST_READOUT = "en reposo · nada guardado";

export function readoutOf(pose: CapturePose): string {
  if (pose.card > 0.85 && pose.stamp > 0.9) return "sellado · el momento entra en el proyecto";
  if (pose.stamp > 0.15) return "el sello baja · solo porque confirmaste";
  if (pose.arm > 0.82 && !pose.said) return "perno echado · aún no has hablado";
  if ((pose.talk > 0.45 || pose.said) && pose.stamp < 0.15) return "dicho · pendiente de tu confirmación";
  if (pose.seen > 0.45) return "visto · todavía no se guarda";
  return REST_READOUT;
}

/** El sello espera a que el perno esté echado y a que hayas hablado. El perno no retrocede mientras el sello está abajo. */
export function stepCapture(pose: CapturePose, input: CaptureInput, dt: number, calm: boolean, follow: Follow): CapturePose {
  const talk = follow(pose.talk, input.talk, dt, 0.08, calm);
  const seen = follow(pose.seen, input.seen, dt, 0.12, calm);
  const arm = pose.stamp > 0.12 ? Math.max(pose.arm, input.arm) : follow(pose.arm, input.arm, dt, 0.1, calm);
  const stampTarget = input.said && input.arm > 0.5 && arm > 0.82 ? 1 : 0;
  const stamp = follow(pose.stamp, stampTarget, dt, 0.14, calm);
  const card = follow(pose.card, stamp > 0.92 ? 1 : 0, dt, 0.16, calm);
  return { talk, arm, stamp, card, seen, said: input.said };
}

type Follow = (current: number, target: number, dt: number, seconds: number, calm: boolean) => number;

const LOOP = 9.2;

/** Recorrido en reposo: ver, hablar, confirmar, sellar, volver. */
export function tourAt(time: number): CaptureInput {
  const at = time % LOOP;
  if (at < 0.8) return { seen: 0, talk: 0, arm: 0, said: false };
  if (at < 1.7) return { seen: 1, talk: 0, arm: 0, said: false };
  if (at < 3.1) return { seen: 1, talk: 1, arm: 0, said: true };
  if (at < 3.9) return { seen: 1, talk: 0, arm: 0, said: true };
  if (at < 6.6) return { seen: 1, talk: 0, arm: 1, said: true };
  if (at < 7.8) return { seen: 1, talk: 0, arm: 1, said: true };
  return { seen: 0, talk: 0, arm: 0, said: false };
}
