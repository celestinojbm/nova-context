/** Modelo de la caja de salida. La ficha exterior solo avanza si la llave está metida. */

export interface LockPose {
  drawer: number;
  key: number;
  bolt: number;
  door: number;
  card: number;
}

export interface LockInput {
  drawer: number;
  key: number;
}

export const REST_LOCK: LockPose = { drawer: 0, key: 0, bolt: 0, door: 0, card: 0 };

export const REST_LOCK_READOUT = "cerrado · nada sale";

export function lockReadout(pose: LockPose): string {
  if (pose.card > 0.85) return "la acción sale · porque echaste la llave";
  if (pose.key > 0.75 && pose.bolt < 0.85) return "llave metida · el pestillo cede";
  if (pose.door > 0.2 && pose.card < 0.85) return "la trampilla abre · la ficha empieza a salir";
  if (pose.drawer > 0.45 && pose.key < 0.4) return "el proyecto se asoma · la salida sigue cerrada";
  if (pose.key > 0.75) return "pestillo retirado · la salida está franca";
  return REST_LOCK_READOUT;
}

type Follow = (current: number, target: number, dt: number, seconds: number, calm: boolean) => number;

export function stepLock(pose: LockPose, input: LockInput, dt: number, calm: boolean, follow: Follow): LockPose {
  const drawer = follow(pose.drawer, input.drawer, dt, 0.14, calm);
  const key = follow(pose.key, input.key, dt, 0.12, calm);
  const bolt = follow(pose.bolt, key > 0.92 ? 1 : 0, dt, 0.12, calm);
  const door = follow(pose.door, bolt > 0.88 ? 1 : 0, dt, 0.14, calm);
  const card = follow(pose.card, door > 0.82 ? 1 : 0, dt, 0.18, calm);
  return { drawer, key, bolt, door, card };
}

const LOOP = 10;

export function lockTour(time: number): LockInput {
  const at = time % LOOP;
  if (at < 1.2) return { drawer: 0, key: 0 };
  if (at < 3.2) return { drawer: 1, key: 0 };
  if (at < 4.2) return { drawer: 0, key: 0 };
  if (at < 8) return { drawer: 0, key: 1 };
  return { drawer: 0, key: 0 };
}
