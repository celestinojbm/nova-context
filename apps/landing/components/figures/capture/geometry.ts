import {
  boxCorners,
  circleRing,
  corners,
  cylinder,
  depthOf,
  dotGrid,
  fitProjection,
  insetPlan,
  iso,
  joinPaths,
  knurl,
  onTop,
  pathOf,
  planOutline,
  radialTicks,
  slabOf,
  topTicks,
  translateAlong,
  type Flat,
  type Plan,
  type Point3,
  type Projection,
  type SolidPaths,
} from "../../iso/iso-kit";

export const WIDTH = 680;
export const HEIGHT = 430;

const AZIMUTH = 48;
const ELEVATION = 32;

export const BASE: Plan = { x: 18, y: 16, w: 300, d: 178, r: 10 };
export const BASE_H = 10;
export const FOOT_H = 5;

export const PLUNGER_TRAVEL = 7;
export const STAMP_TRAVEL = 11;
export const BOLT_TRAVEL = 20;
export const CARD_TRAVEL = 18;

const ROD_X0 = 214;
const ROD_X1 = 248;
const ROD_Y = 116;
const ROD_R = 2.1;
const SPRING_R = 4.6;
const SPRING_Z0 = 8;
const SPRING_Z1 = 20;

const MIC_X = 62;
const MIC_Y = 58;
const HEAD_Z = 18;
const HEAD_H = 8;
const CAP_Z = HEAD_Z + HEAD_H + PLUNGER_TRAVEL;

const DIAL_X = 274;
const DIAL_Y = 52;
const DIAL_TOP = 11;

const bounds: Point3[] = [
  ...boxCorners(BASE, -BASE_H - FOOT_H, 4),
  [160, 156, 84],
  [ROD_X0, ROD_Y, 50],
  [ROD_X1, ROD_Y, 50],
  [MIC_X, MIC_Y, CAP_Z + 8],
  [DIAL_X, DIAL_Y, DIAL_TOP + 4],
  [46, 146, 36],
];

export const P: Projection = fitProjection(bounds, WIDTH, HEIGHT, {
  pad: 30,
  azimuth: AZIMUTH,
  elevation: ELEVATION,
});

const slab = (plan: Plan, z: number, h: number, bevel = 0.7, steps = 6): SolidPaths => slabOf(plan, z, h, P, steps, bevel);
const drum = (x: number, y: number, r: number, z: number, h: number, steps = 28, bevel = 0.45): SolidPaths =>
  cylinder(x, y, r, z, h, P, steps, bevel);
const topRing = (x: number, y: number, r: number, z: number, steps = 28) => onTop(circleRing(x, y, r, steps), z, P, true);
const seg = (a: Point3, b: Point3) => pathOf([iso(a, P), iso(b, P)]);

function coilZ(z0: number, z1: number, cx: number, cy: number, radius: number, turns: number) {
  const count = Math.max(8, Math.round(turns * 14));
  const back: string[] = [];
  const front: string[] = [];
  let run: Flat[] = [];
  let near: boolean | null = null;
  const span = Math.max(z1 - z0, 0.8);
  for (let index = 0; index <= count; index++) {
    const share = index / count;
    const angle = share * turns * Math.PI * 2;
    const point: Point3 = [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle), z0 + span * share];
    const normal: Point3 = [Math.cos(angle), Math.sin(angle), 0];
    const facing = depthOf(normal, P) > 0;
    const flat = iso(point, P);
    if (near === null) near = facing;
    if (facing !== near) {
      run.push(flat);
      (near ? front : back).push(pathOf(run));
      run = [flat];
      near = facing;
      continue;
    }
    run.push(flat);
  }
  if (run.length > 1) (near ? front : back).push(pathOf(run));
  return { back: back.join(""), front: front.join("") };
}

const FEET = corners(BASE, 24);
const SCREWS = corners(BASE, 9);

const PLATE: Plan = { x: 36, y: 30, w: 52, d: 15, r: 1.6 };
const CHEEK_L: Plan = { x: 28, y: 48, w: 11, d: 128, r: 2 };
const CHEEK_R: Plan = { x: 292, y: 48, w: 11, d: 128, r: 2 };
const BRIDGE: Plan = { x: 40, y: 168, w: 246, d: 12, r: 2 };

const BEZEL: Plan = { x: 92, y: 82, w: 112, d: 66, r: 3 };
const GLASS: Plan = { x: 100, y: 90, w: 96, d: 50, r: 2 };
const POST_L: Plan = { x: 96, y: 132, w: 10, d: 10, r: 1.5 };
const POST_R: Plan = { x: 190, y: 132, w: 10, d: 10, r: 1.5 };

const LAMP_X = 158;
const LAMP_Y = 152;

const VIAL_X = 48;
const VIAL_Y = 142;

const ANVIL: Plan = { x: 204, y: 104, w: 54, d: 26, r: 2 };
const SLAB: Plan = { x: 220, y: 106, w: 22, d: 20, r: 1.5 };
const DIE: Plan = { x: 224, y: 110, w: 14, d: 12, r: 1 };

const BOLT_BED: Plan = { x: 196, y: 90, w: 62, d: 10, r: 1.5 };
const BOLT: Plan = { x: 228, y: 88, w: 22, d: 12, r: 1.5 };

const TRAY: Plan = { x: 118, y: 22, w: 100, d: 52, r: 2 };
const CARD: Plan = { x: 128, y: 28, w: 58, d: 16, r: 1 };

const BOOT_A: Plan = { x: 54, y: 70, w: 10, d: 8, r: 1.2 };
const BOOT_B: Plan = { x: 228, y: 156, w: 10, d: 8, r: 1.2 };

function clips(): SolidPaths[] {
  const spots: Plan[] = [
    { x: GLASS.x - 1, y: GLASS.y - 1, w: 8, d: 6, r: 1 },
    { x: GLASS.x + GLASS.w - 7, y: GLASS.y - 1, w: 8, d: 6, r: 1 },
    { x: GLASS.x - 1, y: GLASS.y + GLASS.d - 5, w: 8, d: 6, r: 1 },
    { x: GLASS.x + GLASS.w - 7, y: GLASS.y + GLASS.d - 5, w: 8, d: 6, r: 1 },
  ];
  return spots.map((plan) => slab(plan, 36.2, 1.6, 0.3, 4));
}

const glassRules = joinPaths(
  [0, 1, 2, 3].map((row) => {
    const y = GLASS.y + 10 + row * 8;
    const end = row === 3 ? GLASS.x + 46 : GLASS.x + GLASS.w - 12;
    return pathOf([iso([GLASS.x + 10, y, 38.5], P), iso([end, y, 38.5], P)]);
  }),
);

const cardRules = joinPaths(
  [0, 1].map((row) => pathOf([iso([CARD.x + 6, CARD.y + 5 + row * 5, 8.4], P), iso([CARD.x + CARD.w - 8, CARD.y + 5 + row * 5, 8.4], P)])),
);

const ticks = topTicks(48, 280, 8, 5, BASE.y, 0.15, [-3.2, -6], P, "x");
const dialTicks = radialTicks(DIAL_X, DIAL_Y, 10.5, 16, 4, DIAL_TOP + 0.15, [1.6, 2.8], P, -2.4, 2.2);

export function springsOf(stamp: number) {
  const z1 = SPRING_Z1 - STAMP_TRAVEL * stamp;
  const left = coilZ(SPRING_Z0, z1, ROD_X0, ROD_Y, SPRING_R, 5.5);
  const right = coilZ(SPRING_Z0, z1, ROD_X1, ROD_Y, SPRING_R, 5.5);
  return { back: left.back + right.back, front: left.front + right.front };
}

export function needleOf(stamp: number, talk: number) {
  const angle = -2.15 + 1.55 * stamp + 0.12 * talk;
  const len = 8.4;
  return seg([DIAL_X, DIAL_Y, DIAL_TOP + 0.35], [DIAL_X + Math.sin(angle) * len, DIAL_Y - Math.cos(angle) * len, DIAL_TOP + 0.35]);
}

const cableFlats: Flat[] = [
  [MIC_X, 74, 1.2],
  [34, 74, 1.2],
  [34, 164, 1.2],
  [236, 164, 1.2],
  [236, 150, 1.2],
].map((point) => iso(point as Point3, P));

export interface CaptureVisual {
  plunger: string;
  bolt: string;
  stamp: string;
  card: string;
  needle: string;
  coilBack: string;
  coilFront: string;
  glassLit: boolean;
  dieLit: boolean;
}

export function visualOf(pose: { talk: number; arm: number; stamp: number; card: number }): CaptureVisual {
  const springs = springsOf(pose.stamp);
  return {
    plunger: translateAlong(P, [0, 0, -PLUNGER_TRAVEL * pose.talk]),
    bolt: translateAlong(P, [-BOLT_TRAVEL * pose.arm, 0, 0]),
    stamp: translateAlong(P, [0, 0, -STAMP_TRAVEL * pose.stamp]),
    card: translateAlong(P, [0, CARD_TRAVEL * pose.card, 0]),
    needle: needleOf(pose.stamp, pose.talk),
    coilBack: springs.back,
    coilFront: springs.front,
    glassLit: pose.stamp < 0.45,
    dieLit: pose.stamp >= 0.45,
  };
}

export const REST_VISUAL = visualOf({ talk: 0, arm: 0, stamp: 0, card: 0 });

const bush = (x: number): SolidPaths => drum(x, ROD_Y, 5.2, 20, 8, 22, 0.4);

export const ART = {
  halo: slab(BASE, -BASE_H - FOOT_H, BASE_H, 0, 8).fill,
  feet: FEET.map(([x, y]) => [drum(x, y, 8, -BASE_H - FOOT_H, 1.7, 22, 0.3), drum(x, y, 5.6, -BASE_H - FOOT_H + 1.7, FOOT_H - 1.7, 20, 0.3)]),
  base: slab(BASE, -BASE_H, BASE_H, 1.4, 8),
  groove: planOutline(insetPlan(BASE, 5), 0.05, P, 8),
  screwRings: joinPaths(SCREWS.map(([x, y]) => topRing(x, y, 2.3, 0.05, 14))),
  screws: SCREWS.map(([x, y]) => iso([x, y, 0.05], P)),
  plate: slab(PLATE, 0, 0.9, 0.2, 4),
  plateLine: planOutline(insetPlan(PLATE, 1.5), 0.9, P, 4),
  plateRules: joinPaths([0, 1, 2].map((row) => pathOf([iso([PLATE.x + 6, PLATE.y + 4 + row * 3.2, 0.95], P), iso([PLATE.x + (row === 1 ? 28 : 40), PLATE.y + 4 + row * 3.2, 0.95], P)]))),
  plateScrews: [iso([PLATE.x + 3.2, PLATE.y + PLATE.d / 2, 0.95], P), iso([PLATE.x + PLATE.w - 3.2, PLATE.y + PLATE.d / 2, 0.95], P)],
  cheeks: [slab(CHEEK_L, 0, 14, 0.6), slab(CHEEK_R, 0, 14, 0.6)],
  bridge: slab(BRIDGE, 0, 8, 0.6),
  ticksMinor: ticks.minor,
  ticksMajor: ticks.major,
  posts: [slab(POST_L, 0, 32, 0.4), slab(POST_R, 0, 32, 0.4)],
  bezel: slab(BEZEL, 32, 3.2, 0.5),
  glass: slab(GLASS, 35.2, 2.6, 0.35),
  glassRules,
  clips: clips(),
  lampFoot: drum(LAMP_X, LAMP_Y, 10, 0, 2.2, 24, 0.3),
  lampStem: drum(LAMP_X, LAMP_Y, 3.2, 2.2, 48, 16, 0.2),
  lampNeck: drum(LAMP_X, LAMP_Y, 6, 50, 4, 20, 0.3),
  lampHead: drum(LAMP_X, LAMP_Y, 11, 54, 8, 28, 0.6),
  lampShade: drum(LAMP_X, LAMP_Y, 16, 62, 5, 32, 0.5),
  lampCap: drum(LAMP_X, LAMP_Y, 4, 67, 3, 16, 0.3),
  vialFoot: drum(VIAL_X, VIAL_Y, 7, 0, 1.6, 20, 0.2),
  vial: drum(VIAL_X, VIAL_Y, 5.5, 1.6, 22, 22, 0.4),
  vialCap: drum(VIAL_X, VIAL_Y, 6.4, 23.6, 3.2, 20, 0.3),
  vialMark: topRing(VIAL_X, VIAL_Y, 4.2, 23.7, 24),
  micPlinth: slab({ x: MIC_X - 12, y: MIC_Y - 12, w: 24, d: 24, r: 3 }, 0, 3, 0.4),
  micColumn: drum(MIC_X, MIC_Y, 5, 3, HEAD_Z - 3, 18, 0.3),
  stem: drum(MIC_X, MIC_Y, 2.6, HEAD_Z + HEAD_H, PLUNGER_TRAVEL, 14, 0.2),
  head: drum(MIC_X, MIC_Y, 9, HEAD_Z, HEAD_H, 28, 0.45),
  headBore: topRing(MIC_X, MIC_Y, 3.4, HEAD_Z + HEAD_H, 16),
  cap: drum(MIC_X, MIC_Y, 8.2, CAP_Z, 5, 28, 0.5),
  capKnurl: knurl(MIC_X, MIC_Y, 8.2, CAP_Z + 0.6, CAP_Z + 4.4, 22, P, 0.35),
  grille: dotGrid(MIC_X - 4.5, MIC_Y - 4.5, 4, 4, 3, CAP_Z + 5.05, P),
  anvil: slab(ANVIL, 2, 6, 0.45),
  sheet: slab({ x: 222, y: 108, w: 18, d: 16, r: 0.8 }, 8, 0.8, 0, 4),
  rods: [drum(ROD_X0, ROD_Y, ROD_R, 8, 40, 14, 0.15), drum(ROD_X1, ROD_Y, ROD_R, 8, 40, 14, 0.15)],
  rodTops: [topRing(ROD_X0, ROD_Y, ROD_R + 0.2, 48, 12), topRing(ROD_X1, ROD_Y, ROD_R + 0.2, 48, 12)],
  bushes: [bush(ROD_X0), bush(ROD_X1)],
  stamp: slab(SLAB, 28, 6, 0.45),
  die: slab(DIE, 20, 8, 0.3),
  collar: [drum(ROD_X0, ROD_Y, 3.4, 6, 2.2, 14, 0.2), drum(ROD_X1, ROD_Y, 3.4, 6, 2.2, 14, 0.2)],
  boltBed: slab(BOLT_BED, 6, 2.4, 0.3),
  bolt: slab(BOLT, 8.4, 5, 0.4),
  thumb: drum(239, 94, 4.2, 13.4, 4.2, 18, 0.35),
  thumbKnurl: knurl(239, 94, 4.2, 13.8, 17.2, 14, P, 0.25),
  trayFloor: slab(insetPlan(TRAY, 3), 0, 1.2, 0, 4),
  trayWalls: [
    slab({ x: TRAY.x, y: TRAY.y, w: TRAY.w, d: 3.2, r: 0.8 }, 1.2, 6, 0.3, 4),
    slab({ x: TRAY.x, y: TRAY.y + TRAY.d - 3.2, w: TRAY.w, d: 3.2, r: 0.8 }, 1.2, 6, 0.3, 4),
    slab({ x: TRAY.x, y: TRAY.y, w: 3.2, d: TRAY.d, r: 0.8 }, 1.2, 6, 0.3, 4),
    slab({ x: TRAY.x + TRAY.w - 3.2, y: TRAY.y, w: 3.2, d: TRAY.d, r: 0.8 }, 1.2, 6, 0.3, 4),
  ],
  card: slab(CARD, 2.4, 1.1, 0.15, 4),
  cardRules,
  dial: drum(DIAL_X, DIAL_Y, 13, 0, DIAL_TOP, 32, 0.5),
  dialLip: drum(DIAL_X, DIAL_Y, 11.2, DIAL_TOP, 1.3, 28, 0.2),
  dialFace: topRing(DIAL_X, DIAL_Y, 9.2, DIAL_TOP + 1.3, 28),
  dialTicksMinor: dialTicks.minor,
  dialTicksMajor: dialTicks.major,
  hub: drum(DIAL_X, DIAL_Y, 1.5, DIAL_TOP + 1.3, 0.8, 12, 0.1),
  boots: [slab(BOOT_A, 0, 2.4, 0.3, 4), slab(BOOT_B, 0, 2.4, 0.3, 4)],
  cableFrom: cableFlats[0]!,
  cableTo: cableFlats[cableFlats.length - 1]!,
  cableVia: cableFlats.slice(1, -1),
};

export const HITS = {
  glass: iso([GLASS.x + GLASS.w / 2, GLASS.y + GLASS.d / 2, 38], P),
  cap: iso([MIC_X, MIC_Y, CAP_Z + 4], P),
  bolt: iso([239, 94, 16], P),
};

export const CAPTURE_KEYS = [
  { mark: "lit" as const, label: "Lo que se te muestra y aún no se guarda" },
  { mark: "edge" as const, label: "El sello, que solo baja con el perno echado y tu voz" },
  { mark: "dotted" as const, label: "El margen local, que no abandona el banco" },
];

export const CAPTION =
  "El cristal enseña lo que hay en pantalla y todavía no se guarda. El émbolo es tu voz. El perno tiene que estar echado, y tienes que haber hablado, para que el sello baje y la ficha entre en la bandeja. El vial de atrás no enlaza con el cable: ese margen se queda en el banco.";
