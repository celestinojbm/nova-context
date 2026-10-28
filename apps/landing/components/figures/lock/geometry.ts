import {
  boxCorners,
  circleRing,
  corners,
  cylinder,
  dotGrid,
  fitProjection,
  insetPlan,
  iso,
  joinPaths,
  knurl,
  onTop,
  pathOf,
  planOutline,
  slabOf,
  topMatrix,
  translateAlong,
  type Plan,
  type Point3,
  type SolidPaths,
} from "../../iso/iso-kit";

export const WIDTH = 680;
export const HEIGHT = 430;

const CASE: Plan = { x: 36, y: 48, w: 220, d: 108, r: 4 };
const CASE_TOP = 78;
const PLINTH_H = 6;

const bounds: Point3[] = [...boxCorners(CASE, -8, CASE_TOP + 28), [40, 20, 0], [250, 150, 4], [198, 78, CASE_TOP + 30]];

export const P = fitProjection(bounds, WIDTH, HEIGHT, { pad: 32, azimuth: 50, elevation: 34 });

const slab = (plan: Plan, z: number, h: number, bevel = 0.6, steps = 5): SolidPaths => slabOf(plan, z, h, P, steps, bevel);
const drum = (x: number, y: number, r: number, z: number, h: number, steps = 24, bevel = 0.4) => cylinder(x, y, r, z, h, P, steps, bevel);
const topRing = (x: number, y: number, r: number, z: number) => onTop(circleRing(x, y, r, 24), z, P, true);

export const DRAWER_TRAVEL = 24;
export const KEY_TRAVEL = 8;
export const BOLT_TRAVEL = 16;
export const DOOR_TRAVEL = 16;
export const CARD_TRAVEL = 22;

const ROSE_X = 200;
const ROSE_Y = 112;
const ROSE_Z = CASE_TOP + 4;

const DRAWER_FRONT: Plan = { x: 52, y: 40, w: 128, d: 8, r: 1.4 };

export interface LockVisual {
  drawer: string;
  key: string;
  bolt: string;
  door: string;
  card: string;
  egressLit: boolean;
}

export function lockVisual(pose: { drawer: number; key: number; bolt: number; door: number; card: number }): LockVisual {
  return {
    drawer: translateAlong(P, [0, -DRAWER_TRAVEL * pose.drawer, 0]),
    key: translateAlong(P, [0, 0, -KEY_TRAVEL * pose.key]),
    bolt: translateAlong(P, [BOLT_TRAVEL * pose.bolt, 0, 0]),
    door: translateAlong(P, [0, 0, -DOOR_TRAVEL * pose.door]),
    card: translateAlong(P, [0, -CARD_TRAVEL * pose.card, 0]),
    egressLit: pose.card > 0.35 || pose.door > 0.45,
  };
}

export const REST_LOCK_VISUAL = lockVisual({ drawer: 0, key: 0, bolt: 0, door: 0, card: 0 });

const FEET = corners({ x: 48, y: 58, w: 196, d: 86, r: 4 }, 8);

const MID_Z = 34;
const BOX: Plan = { x: 56, y: 48, w: 120, d: 52, r: 1.2 };
const INNER_CARD: Plan = { x: 70, y: 62, w: 78, d: 22, r: 1 };

const CHUTE: Plan = { x: 186, y: 36, w: 52, d: 14, r: 1.2 };
const DOOR: Plan = { x: 192, y: 34, w: 40, d: 5, r: 0.8 };
const EGRESS: Plan = { x: 196, y: 44, w: 32, d: 14, r: 1 };
const BOLT: Plan = { x: 190, y: 40, w: 18, d: 6, r: 1 };

const pulls = [14, MID_Z + 8, 58].map((z) => drum(116, 40, 3.2, z, 5, 16, 0.3));

function drawerFront(z: number) {
  return slab(DRAWER_FRONT, z, 16, 0.45);
}

export const LABEL = topMatrix([212, 40], 22.6, P, "x");

export const ART = {
  halo: slab({ x: 40, y: 52, w: 212, d: 100, r: 8 }, -7, 6, 0, 6).fill,
  feet: FEET.map(([x, y]) => [drum(x, y, 7, -7, 1.6, 18, 0.25), drum(x, y, 5, -5.4, 5.4, 16, 0.25)]),
  plinth: slab({ x: 42, y: 54, w: 208, d: 98, r: 3 }, 0, PLINTH_H, 0.7),
  groove: planOutline(insetPlan({ x: 48, y: 84, w: 196, d: 60, r: 2 }, 4), CASE_TOP + 4.05, P, 6),
  screws: [
    [58, 94],
    [230, 94],
    [58, 134],
    [230, 134],
  ].map(([x, y]) => iso([x, y, CASE_TOP + 4.1], P)),
  screwRings: joinPaths(
    [
      [58, 94],
      [230, 94],
      [58, 134],
      [230, 134],
    ].map(([x, y]) => topRing(x, y, 2.1, CASE_TOP + 4.05)),
  ),
  back: slab({ x: 44, y: 140, w: 204, d: 10, r: 1.5 }, PLINTH_H, CASE_TOP - PLINTH_H, 0.5),
  left: slab({ x: 44, y: 56, w: 10, d: 86, r: 1.5 }, PLINTH_H, CASE_TOP - PLINTH_H, 0.5),
  right: slab({ x: 238, y: 56, w: 10, d: 86, r: 1.5 }, PLINTH_H, CASE_TOP - PLINTH_H, 0.5),
  top: slab({ x: 44, y: 80, w: 204, d: 70, r: 2 }, CASE_TOP, 4, 0.6),
  stile: slab({ x: 184, y: 44, w: 56, d: 16, r: 1.5 }, PLINTH_H, CASE_TOP - PLINTH_H, 0.5),
  shelf: slab({ x: 188, y: 50, w: 48, d: 28, r: 1 }, 28, 3, 0.3),
  lowerFront: drawerFront(12),
  upperFront: drawerFront(56),
  lowerPull: pulls[0]!,
  upperPull: pulls[2]!,
  midFront: drawerFront(MID_Z),
  midPull: pulls[1]!,
  midMark: planOutline(insetPlan(DRAWER_FRONT, 1.8), MID_Z + 16.05, P, 4),
  boxFloor: slab(BOX, MID_Z, 2, 0.2, 4),
  boxSides: [
    slab({ x: BOX.x, y: BOX.y, w: 4, d: BOX.d, r: 0.6 }, MID_Z, 12, 0.3, 4),
    slab({ x: BOX.x + BOX.w - 4, y: BOX.y, w: 4, d: BOX.d, r: 0.6 }, MID_Z, 12, 0.3, 4),
    slab({ x: BOX.x, y: BOX.y + BOX.d - 4, w: BOX.w, d: 4, r: 0.6 }, MID_Z, 12, 0.3, 4),
  ],
  innerCard: slab(INNER_CARD, MID_Z + 2.2, 0.9, 0.1, 4),
  innerRules: joinPaths([0, 1].map((row) => pathOf([iso([INNER_CARD.x + 6, INNER_CARD.y + 6 + row * 6, MID_Z + 3.2], P), iso([INNER_CARD.x + INNER_CARD.w - 8, INNER_CARD.y + 6 + row * 6, MID_Z + 3.2], P)]))),
  rose: drum(ROSE_X, ROSE_Y, 9, ROSE_Z, 5, 28, 0.4),
  roseLip: drum(ROSE_X, ROSE_Y, 6.5, ROSE_Z + 5, 1.4, 24, 0.2),
  roseBore: topRing(ROSE_X, ROSE_Y, 2.4, ROSE_Z + 6.4),
  stem: drum(ROSE_X, ROSE_Y, 1.8, ROSE_Z + 6.4, KEY_TRAVEL, 12, 0.15),
  bit: slab({ x: ROSE_X + 4.2, y: ROSE_Y - 3.5, w: 6, d: 7, r: 0.5 }, ROSE_Z + 6.4 + KEY_TRAVEL, 2.2, 0.2, 4),
  bow: drum(ROSE_X, ROSE_Y, 7.4, ROSE_Z + 6.4 + KEY_TRAVEL + 2.2, 2.2, 24, 0.3),
  bowHole: topRing(ROSE_X, ROSE_Y, 3.2, ROSE_Z + 8.6 + KEY_TRAVEL + 2.2),
  chuteFloor: slab(CHUTE, 8, 2, 0.3, 4),
  chuteCheeks: [
    slab({ x: 186, y: 36, w: 4, d: 16, r: 0.6 }, 10, 18, 0.3, 4),
    slab({ x: 234, y: 36, w: 4, d: 16, r: 0.6 }, 10, 18, 0.3, 4),
  ],
  lintel: slab({ x: 186, y: 36, w: 52, d: 8, r: 0.8 }, 28, 4, 0.3, 4),
  door: slab(DOOR, 12, 14, 0.35, 4),
  doorSeam: planOutline(insetPlan(DOOR, 1.4), 26, P, 4),
  boltGuide: slab({ x: 188, y: 42, w: 40, d: 5, r: 0.6 }, 24, 2.2, 0.2, 4),
  bolt: slab(BOLT, 26.2, 3, 0.25, 4),
  egress: slab(EGRESS, 11, 1, 0.1, 4),
  egressRules: joinPaths([0, 1].map((row) => pathOf([iso([EGRESS.x + 4, EGRESS.y + 4 + row * 4, 12.15], P), iso([EGRESS.x + EGRESS.w - 5, EGRESS.y + 4 + row * 4, 12.15], P)]))),
  plate: slab({ x: 168, y: 96, w: 28, d: 10, r: 1 }, CASE_TOP + 4, 0.8, 0.15, 4),
  plateRules: joinPaths([0, 1].map((row) => pathOf([iso([174, 99 + row * 3, CASE_TOP + 4.85], P), iso([190, 99 + row * 3, CASE_TOP + 4.85], P)]))),
  keyKnurl: knurl(ROSE_X, ROSE_Y, 7.4, ROSE_Z + 6.8 + KEY_TRAVEL + 2.2, ROSE_Z + 8.2 + KEY_TRAVEL + 2.2, 16, P, 0.2),
  grille: dotGrid(ROSE_X - 3, ROSE_Y - 3, 3, 3, 3, ROSE_Z + 6.5, P),
  hinge: [drum(52, 46, 1.6, 16, 8, 10, 0.1), drum(172, 46, 1.6, 16, 8, 10, 0.1), drum(52, 46, 1.6, 60, 8, 10, 0.1), drum(172, 46, 1.6, 60, 8, 10, 0.1)],
};

export const LOCK_KEYS = [
  { mark: "lit" as const, label: "La ficha que puede salir" },
  { mark: "edge" as const, label: "El pestillo, que solo cede con la llave" },
  { mark: "dotted" as const, label: "El cajón del proyecto, cuando se asoma" },
];

export const LOCK_CAPTION =
  "Tres cajones: bandeja, proyecto y archivo. El del medio se asoma para enseñar el momento y no abre la salida. La llave entra en la tapa; entonces el pestillo se retira, la trampilla baja y la ficha puede salir. Antes de eso, no.";

export const HITS = {
  drawer: iso([116, 44, MID_Z + 10], P),
  key: iso([ROSE_X, ROSE_Y, ROSE_Z + KEY_TRAVEL + 8], P),
};
