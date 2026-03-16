import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import type { RealtimeEvent } from "../api/client";
import { inferOfficeZone, type OfficeZoneId } from "../data/office-zones";

type CanvasAgent = {
  agentId: string;
  name: string;
  zoneId: OfficeZoneId;
  zoneLabel: string;
  urgency: "critical" | "warning" | "active" | "idle";
  activeSessions: number;
  pendingApprovalCount: number;
  latestAction: string;
};

type CanvasZone = {
  zoneId: OfficeZoneId;
  label: string;
  activeAgents: number;
  pendingApprovalCount: number;
  leadAction: string;
  agents: CanvasAgent[];
};

type PixelOfficeCanvasProps = {
  zones: CanvasZone[];
  selectedAgentId: string | null;
  selectedZoneId: OfficeZoneId | null;
  recentEvents?: RealtimeEvent[];
  onSelectAgent: (agentId: string, zoneId: OfficeZoneId) => void;
  onSelectZone: (zoneId: OfficeZoneId) => void;
};

type Seat = {
  left: string;
  top: string;
  direction: "down" | "up" | "right";
};

type StageSeat = {
  seatId: string;
  zoneId: OfficeZoneId;
  left: string;
  top: string;
  point: Point;
  direction: "down" | "up" | "right";
};

type Waypoint = {
  left: string;
  top: string;
};

type FurnitureDefinition = {
  src: string;
  left: string;
  top: string;
  width: string;
  zIndex?: number;
  className?: string;
};

type RoomDefinition = {
  zoneId: OfficeZoneId;
  left: string;
  top: string;
  width: string;
  height: string;
  floor: "wood" | "light" | "blue";
  door: Waypoint;
  wanderSpots: Waypoint[];
  seats: Seat[];
  furniture: FurnitureDefinition[];
};

type HallwayDefinition = {
  left: string;
  top: string;
  width: string;
  height: string;
  className?: string;
};

type Point = {
  left: number;
  top: number;
};

type RoomBounds = {
  zoneId: OfficeZoneId;
  left: number;
  top: number;
  width: number;
  height: number;
  door: Point;
};

type StageAgent = CanvasAgent & {
  sprite: string;
  seatId: string;
  seat: Point;
  roomZoneId: OfficeZoneId;
  roomDoor: Point;
  roomWanderSpots: Point[];
  direction: "down" | "up" | "right";
};

type AnimatedAgent = StageAgent & {
  left: number;
  top: number;
  motion: "typing" | "walking" | "idle";
  bubbleType: "permission" | "waiting" | null;
  route: Point[];
  pauseUntil: number;
  intent: "auto" | "command" | "seat";
  commandExpiresAt: number;
};

type DragState = {
  agentId: string;
  startClientX: number;
  startClientY: number;
  clientX: number;
  clientY: number;
  point: Point | null;
  active: boolean;
};

type AmbientSubagent = {
  eventId: string;
  zoneId: OfficeZoneId;
  name: string;
  left: number;
  top: number;
  direction: "down" | "up" | "right";
  sprite: string;
};

const FALLBACK_CHARACTER_SHEET = "/assets/pixel-office/characters/char_0.png";
const CHARACTER_SHEETS = [
  "/assets/pixel-office/characters/char_0.png",
  "/assets/pixel-office/characters/char_1.png",
  "/assets/pixel-office/characters/char_2.png",
  "/assets/pixel-office/characters/char_3.png",
  "/assets/pixel-office/characters/char_4.png",
  "/assets/pixel-office/characters/char_5.png",
] as const;

const WALK_SPEED_PERCENT = 10;
const IDLE_WALK_SPEED_PERCENT = 7;
const FRAME_STEP_LIMIT_SEC = 0.045;
const HALLWAY_DWELL_MIN_SEC = 2;
const HALLWAY_DWELL_MAX_SEC = 6;
const COMMAND_DWELL_MIN_SEC = 3;
const COMMAND_DWELL_MAX_SEC = 5;
const DRAG_THRESHOLD_PX = 8;
const SEAT_DROP_RADIUS = 4.8;
const CAMERA_TRANSLATE_LIMIT = 18;

const BUILDING_ROOMS: RoomDefinition[] = [
  {
    zoneId: "operations",
    left: "4%",
    top: "8%",
    width: "21%",
    height: "19%",
    floor: "wood",
    door: { left: "24%", top: "29.5%" },
    wanderSpots: [
      { left: "12%", top: "18%" },
      { left: "18%", top: "23%" },
      { left: "21%", top: "16%" },
    ],
    seats: [
      { left: "22%", top: "68%", direction: "down" },
      { left: "54%", top: "22%", direction: "down" },
    ],
    furniture: [
      { src: "/assets/pixel-office/furniture/DOUBLE_BOOKSHELF/DOUBLE_BOOKSHELF.png", left: "8%", top: "8%", width: "30%" },
      { src: "/assets/pixel-office/furniture/DOUBLE_BOOKSHELF/DOUBLE_BOOKSHELF.png", left: "54%", top: "8%", width: "30%" },
      { src: "/assets/pixel-office/furniture/CACTUS/CACTUS.png", left: "6%", top: "48%", width: "12%" },
      { src: "/assets/pixel-office/furniture/PLANT_2/PLANT_2.png", left: "82%", top: "72%", width: "10%" },
    ],
  },
  {
    zoneId: "command",
    left: "29%",
    top: "8%",
    width: "24%",
    height: "19%",
    floor: "wood",
    door: { left: "41%", top: "29.5%" },
    wanderSpots: [
      { left: "35%", top: "18%" },
      { left: "42%", top: "19%" },
      { left: "48%", top: "18%" },
    ],
    seats: [
      { left: "30%", top: "64%", direction: "down" },
      { left: "68%", top: "64%", direction: "down" },
    ],
    furniture: [
      { src: "/assets/pixel-office/furniture/DOUBLE_BOOKSHELF/DOUBLE_BOOKSHELF.png", left: "8%", top: "8%", width: "28%" },
      { src: "/assets/pixel-office/furniture/DOUBLE_BOOKSHELF/DOUBLE_BOOKSHELF.png", left: "60%", top: "8%", width: "28%" },
      { src: "/assets/pixel-office/furniture/WHITEBOARD/WHITEBOARD.png", left: "36%", top: "56%", width: "28%" },
      { src: "/assets/pixel-office/furniture/CLOCK/CLOCK.png", left: "82%", top: "8%", width: "8%" },
    ],
  },
  {
    zoneId: "security",
    left: "58%",
    top: "8%",
    width: "36%",
    height: "21%",
    floor: "light",
    door: { left: "58%", top: "30.5%" },
    wanderSpots: [
      { left: "66%", top: "19%" },
      { left: "75%", top: "19%" },
      { left: "85%", top: "22%" },
    ],
    seats: [
      { left: "48%", top: "56%", direction: "down" },
      { left: "74%", top: "70%", direction: "down" },
    ],
    furniture: [
      { src: "/assets/pixel-office/furniture/BOOKSHELF/BOOKSHELF.png", left: "4%", top: "10%", width: "12%" },
      { src: "/assets/pixel-office/furniture/PC/PC_FRONT_OFF.png", left: "12%", top: "8%", width: "5%", className: "pixel-office-screen" },
      { src: "/assets/pixel-office/furniture/COFFEE/COFFEE.png", left: "20%", top: "12%", width: "8%" },
      { src: "/assets/pixel-office/furniture/BIN/BIN.png", left: "66%", top: "34%", width: "6%" },
      { src: "/assets/pixel-office/furniture/TABLE_FRONT/TABLE_FRONT.png", left: "72%", top: "8%", width: "22%" },
      { src: "/assets/pixel-office/furniture/BOOKSHELF/BOOKSHELF.png", left: "88%", top: "6%", width: "8%" },
      { src: "/assets/pixel-office/furniture/CLOCK/CLOCK.png", left: "44%", top: "4%", width: "6%" },
    ],
  },
  {
    zoneId: "build",
    left: "12%",
    top: "40%",
    width: "38%",
    height: "48%",
    floor: "wood",
    door: { left: "50%", top: "58%" },
    wanderSpots: [
      { left: "22%", top: "48%" },
      { left: "33%", top: "63%" },
      { left: "42%", top: "72%" },
    ],
    seats: [
      { left: "24%", top: "30%", direction: "up" },
      { left: "62%", top: "30%", direction: "up" },
      { left: "24%", top: "68%", direction: "down" },
      { left: "62%", top: "68%", direction: "down" },
      { left: "44%", top: "48%", direction: "down" },
    ],
    furniture: [
      { src: "/assets/pixel-office/furniture/DESK/DESK_FRONT.png", left: "10%", top: "12%", width: "24%" },
      { src: "/assets/pixel-office/furniture/PC/PC_FRONT_ON_2.png", left: "18%", top: "8%", width: "6%", className: "pixel-office-screen" },
      { src: "/assets/pixel-office/furniture/WOODEN_CHAIR/WOODEN_CHAIR_FRONT.png", left: "18%", top: "30%", width: "6%" },
      { src: "/assets/pixel-office/furniture/DESK/DESK_FRONT.png", left: "52%", top: "12%", width: "24%" },
      { src: "/assets/pixel-office/furniture/PC/PC_FRONT_ON_1.png", left: "60%", top: "8%", width: "6%", className: "pixel-office-screen" },
      { src: "/assets/pixel-office/furniture/WOODEN_CHAIR/WOODEN_CHAIR_FRONT.png", left: "60%", top: "30%", width: "6%" },
      { src: "/assets/pixel-office/furniture/DESK/DESK_FRONT.png", left: "10%", top: "58%", width: "24%" },
      { src: "/assets/pixel-office/furniture/PC/PC_FRONT_OFF.png", left: "18%", top: "54%", width: "6%", className: "pixel-office-screen" },
      { src: "/assets/pixel-office/furniture/DESK/DESK_FRONT.png", left: "52%", top: "58%", width: "24%" },
      { src: "/assets/pixel-office/furniture/PC/PC_FRONT_OFF.png", left: "60%", top: "54%", width: "6%", className: "pixel-office-screen" },
      { src: "/assets/pixel-office/furniture/PLANT/PLANT.png", left: "84%", top: "80%", width: "8%" },
      { src: "/assets/pixel-office/furniture/PLANT_2/PLANT_2.png", left: "2%", top: "82%", width: "8%" },
      { src: "/assets/pixel-office/furniture/BIN/BIN.png", left: "4%", top: "84%", width: "5%" },
      { src: "/assets/pixel-office/furniture/WHITEBOARD/WHITEBOARD.png", left: "38%", top: "84%", width: "22%" },
    ],
  },
  {
    zoneId: "research",
    left: "60%",
    top: "44%",
    width: "30%",
    height: "38%",
    floor: "blue",
    door: { left: "60%", top: "58%" },
    wanderSpots: [
      { left: "68%", top: "56%" },
      { left: "74%", top: "69%" },
      { left: "82%", top: "58%" },
    ],
    seats: [
      { left: "30%", top: "60%", direction: "right" },
      { left: "68%", top: "60%", direction: "right" },
      { left: "48%", top: "84%", direction: "down" },
    ],
    furniture: [
      { src: "/assets/pixel-office/furniture/BOOKSHELF/BOOKSHELF.png", left: "6%", top: "18%", width: "18%" },
      { src: "/assets/pixel-office/furniture/LARGE_PAINTING/LARGE_PAINTING.png", left: "38%", top: "10%", width: "24%" },
      { src: "/assets/pixel-office/furniture/BOOKSHELF/BOOKSHELF.png", left: "76%", top: "18%", width: "18%" },
      { src: "/assets/pixel-office/furniture/PLANT_2/PLANT_2.png", left: "28%", top: "20%", width: "10%" },
      { src: "/assets/pixel-office/furniture/PLANT_2/PLANT_2.png", left: "62%", top: "20%", width: "10%" },
      { src: "/assets/pixel-office/furniture/SOFA/SOFA_SIDE.png", left: "18%", top: "52%", width: "9%" },
      { src: "/assets/pixel-office/furniture/SOFA/SOFA_SIDE.png", left: "74%", top: "52%", width: "9%" },
      { src: "/assets/pixel-office/furniture/COFFEE_TABLE/COFFEE_TABLE.png", left: "42%", top: "54%", width: "18%" },
      { src: "/assets/pixel-office/furniture/COFFEE/COFFEE.png", left: "55%", top: "58%", width: "6%" },
      { src: "/assets/pixel-office/furniture/PLANT/PLANT.png", left: "6%", top: "86%", width: "8%" },
      { src: "/assets/pixel-office/furniture/PLANT/PLANT.png", left: "88%", top: "86%", width: "8%" },
    ],
  },
];

const HALLWAYS: HallwayDefinition[] = [
  { left: "10%", top: "29%", width: "80%", height: "7%", className: "pixel-office-corridor-main" },
  { left: "52%", top: "25%", width: "7%", height: "59%", className: "pixel-office-corridor-main" },
  { left: "13%", top: "27%", width: "4%", height: "4%", className: "pixel-office-corridor-branch" },
  { left: "39%", top: "27%", width: "4%", height: "4%", className: "pixel-office-corridor-branch" },
  { left: "56%", top: "27%", width: "4%", height: "4%", className: "pixel-office-corridor-branch" },
  { left: "50%", top: "55%", width: "2%", height: "5%", className: "pixel-office-corridor-branch" },
  { left: "59%", top: "57%", width: "2%", height: "5%", className: "pixel-office-corridor-branch" },
];

const HALLWAY_NODES: Point[] = [
  { left: 16, top: 32.5 },
  { left: 31, top: 32.5 },
  { left: 46, top: 32.5 },
  { left: 55.5, top: 32.5 },
  { left: 72, top: 32.5 },
  { left: 83, top: 32.5 },
  { left: 55.5, top: 46 },
  { left: 55.5, top: 59 },
  { left: 55.5, top: 73 },
];

const HALLWAY_GRAPH: Record<number, number[]> = {
  0: [1],
  1: [0, 2],
  2: [1, 3],
  3: [2, 4, 6],
  4: [3, 5],
  5: [4],
  6: [3, 7],
  7: [6, 8],
  8: [7],
};

function parsePercent(value: string): number {
  return Number.parseFloat(value.replace("%", ""));
}

function toPoint(value: Waypoint): Point {
  return { left: parsePercent(value.left), top: parsePercent(value.top) };
}

function distanceBetween(from: Point, to: Point): number {
  return Math.hypot(to.left - from.left, to.top - from.top);
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function pickRandom<T>(items: T[], fallback: T): T {
  if (items.length === 0) {
    return fallback;
  }
  return items[Math.floor(Math.random() * items.length)] ?? fallback;
}

function seatIdFor(zoneId: OfficeZoneId, index: number): string {
  return `${zoneId}:seat:${index}`;
}

function normalizeToken(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function collectStrings(input: unknown, depth = 0): Set<string> {
  const values = new Set<string>();
  if (input == null || depth > 2) {
    return values;
  }
  if (typeof input === "string") {
    const normalized = normalizeToken(input);
    if (normalized) {
      values.add(normalized);
    }
    return values;
  }
  if (Array.isArray(input)) {
    for (const item of input) {
      for (const nested of collectStrings(item, depth + 1)) {
        values.add(nested);
      }
    }
    return values;
  }
  if (typeof input === "object") {
    for (const value of Object.values(input as Record<string, unknown>)) {
      for (const nested of collectStrings(value, depth + 1)) {
        values.add(nested);
      }
    }
  }
  return values;
}

function readFirstString(input: unknown, keys: string[]): string | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

const ROOM_BOUNDS: RoomBounds[] = BUILDING_ROOMS.map((room) => ({
  zoneId: room.zoneId,
  left: parsePercent(room.left),
  top: parsePercent(room.top),
  width: parsePercent(room.width),
  height: parsePercent(room.height),
  door: toPoint(room.door),
}));

const ROOM_MAP = new Map(BUILDING_ROOMS.map((room) => [room.zoneId, room]));

function resolveRoomForPoint(point: Point): RoomBounds | null {
  return (
    ROOM_BOUNDS.find(
      (room) =>
        point.left >= room.left &&
        point.left <= room.left + room.width &&
        point.top >= room.top &&
        point.top <= room.top + room.height,
    ) ?? null
  );
}

function findNearestHallwayNode(point: Point): number {
  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  HALLWAY_NODES.forEach((node, index) => {
    const distance = distanceBetween(node, point);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  });
  return nearestIndex;
}

function buildHallwayPath(fromIndex: number, toIndex: number): Point[] {
  if (fromIndex === toIndex) {
    return [HALLWAY_NODES[fromIndex] ?? { left: 50, top: 50 }];
  }

  const queue: number[] = [fromIndex];
  const visited = new Set<number>([fromIndex]);
  const previous = new Map<number, number>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (current == null) {
      continue;
    }
    if (current === toIndex) {
      break;
    }
    for (const next of HALLWAY_GRAPH[current] ?? []) {
      if (visited.has(next)) {
        continue;
      }
      visited.add(next);
      previous.set(next, current);
      queue.push(next);
    }
  }

  const path: number[] = [toIndex];
  let cursor = toIndex;
  while (previous.has(cursor)) {
    cursor = previous.get(cursor) ?? cursor;
    path.unshift(cursor);
  }
  if (path[0] !== fromIndex) {
    path.unshift(fromIndex);
  }
  return path.map((index) => HALLWAY_NODES[index] ?? { left: 50, top: 50 });
}

function appendPoint(route: Point[], point: Point, epsilon = 0.3): void {
  const previous = route.at(-1);
  if (!previous || distanceBetween(previous, point) > epsilon) {
    route.push(point);
  }
}

function buildRouteBetweenPoints(from: Point, target: Point): Point[] {
  const startRoom = resolveRoomForPoint(from);
  const targetRoom = resolveRoomForPoint(target);

  if (startRoom?.zoneId === targetRoom?.zoneId) {
    return [target];
  }

  const route: Point[] = [];
  const startAnchor = startRoom?.door ?? from;
  const targetAnchor = targetRoom?.door ?? target;

  if (startRoom && distanceBetween(from, startAnchor) > 0.8) {
    appendPoint(route, startAnchor);
  }

  const startNode = findNearestHallwayNode(startAnchor);
  const endNode = findNearestHallwayNode(targetAnchor);
  for (const node of buildHallwayPath(startNode, endNode)) {
    appendPoint(route, node);
  }

  if (targetRoom && distanceBetween(route.at(-1) ?? from, targetAnchor) > 0.8) {
    appendPoint(route, targetAnchor);
  }

  appendPoint(route, target);
  return route;
}

function buildIdleRoute(agent: StageAgent): Point[] {
  const roomStop = pickRandom(agent.roomWanderSpots, agent.seat);
  const route: Point[] = [];

  if (Math.random() < 0.72) {
    const firstHallNode = pickRandom(HALLWAY_NODES, agent.roomDoor);
    route.push(agent.roomDoor, firstHallNode);

    if (Math.random() < 0.38) {
      const secondHallNode = pickRandom(
        HALLWAY_NODES.filter((node) => distanceBetween(node, firstHallNode) > 10),
        firstHallNode,
      );
      route.push(secondHallNode);
    }

    route.push(agent.roomDoor);
  }

  route.push(roomStop, agent.seat);
  return route;
}

function getBubbleType(agent: CanvasAgent): AnimatedAgent["bubbleType"] {
  if (agent.pendingApprovalCount > 0) {
    return "permission";
  }
  if (agent.activeSessions > 0 || agent.urgency === "active") {
    return "waiting";
  }
  return null;
}

function getDirection(from: Point, to: Point): StageAgent["direction"] {
  const dx = to.left - from.left;
  const dy = to.top - from.top;

  if (Math.abs(dy) >= Math.abs(dx)) {
    return dy < 0 ? "up" : "down";
  }

  return "right";
}

function updateAnimatedAgent(agent: AnimatedAgent, dt: number, nowSeconds: number): AnimatedAgent {
  const shouldWork = agent.activeSessions > 0 || agent.urgency === "active";
  const bubbleType = getBubbleType(agent);
  let next: AnimatedAgent = { ...agent, bubbleType };

  if (next.route.length > 0) {
    const target = next.route[0];
    if (!target) {
      next.route = [];
      next.motion = "idle";
      return next;
    }

    const remaining = distanceBetween(next, target);
    if (remaining <= 0.4) {
      next.left = target.left;
      next.top = target.top;
      next.route = next.route.slice(1);
      if (next.route.length === 0) {
        if (next.intent === "command") {
          next.motion = "idle";
          if (next.commandExpiresAt <= 0) {
            next.commandExpiresAt = nowSeconds + randomBetween(COMMAND_DWELL_MIN_SEC, COMMAND_DWELL_MAX_SEC);
          }
        } else {
          next.motion = distanceBetween(next, next.seat) <= 0.55 && shouldWork ? "typing" : "idle";
          next.intent = "auto";
          next.commandExpiresAt = 0;
          next.pauseUntil = nowSeconds + randomBetween(HALLWAY_DWELL_MIN_SEC, HALLWAY_DWELL_MAX_SEC);
        }
      } else {
        next.motion = "walking";
      }
      return next;
    }

    next.motion = "walking";
    next.direction = getDirection(next, target);
    const speed = next.intent === "command" ? WALK_SPEED_PERCENT : IDLE_WALK_SPEED_PERCENT;
    const step = Math.min((speed * dt) / remaining, 1);
    next.left = next.left + (target.left - next.left) * step;
    next.top = next.top + (target.top - next.top) * step;
    return next;
  }

  if (next.intent === "command") {
    next.motion = "idle";
    if (next.commandExpiresAt > 0 && nowSeconds < next.commandExpiresAt) {
      return next;
    }
    next.intent = "auto";
    next.commandExpiresAt = 0;
  }

  if (shouldWork) {
    const seatDistance = distanceBetween(next, next.seat);
    if (seatDistance <= 0.55) {
      next.left = next.seat.left;
      next.top = next.seat.top;
      next.motion = "typing";
      next.pauseUntil = nowSeconds + 0.4;
      return next;
    }
    next.motion = "walking";
    next.direction = getDirection(next, next.seat);
    const step = Math.min((WALK_SPEED_PERCENT * dt) / seatDistance, 1);
    next.left = next.left + (next.seat.left - next.left) * step;
    next.top = next.top + (next.seat.top - next.top) * step;
    return next;
  }

  if (nowSeconds >= next.pauseUntil) {
    next.route = buildIdleRoute(next);
    next.motion = next.route.length > 0 ? "walking" : "idle";
    return next;
  }

  next.motion = distanceBetween(next, next.seat) <= 0.6 ? "idle" : "walking";
  return next;
}

function buildAmbientSubagents(events: RealtimeEvent[]): AmbientSubagent[] {
  return events
    .filter((event) => event.eventType === "subagent_registered" || event.eventType === "subagent_updated")
    .slice(0, 4)
    .map((event, index) => {
      const summary =
        readFirstString(event.payload, ["name", "label", "summary", "message"]) ??
        readFirstString(event.payload, ["roleId", "agentId", "subagentId"]) ??
        "Subagent";
      const hints = collectStrings(event.payload);
      const zoneId = inferOfficeZone({
        name: summary,
        summary: Array.from(hints).join(" "),
      });
      const room = ROOM_MAP.get(zoneId) ?? BUILDING_ROOMS[0];
      const point = room?.wanderSpots[index % room.wanderSpots.length] ?? room?.door ?? { left: "50%", top: "50%" };
      return {
        eventId: event.eventId,
        zoneId,
        name: summary,
        left: parsePercent(point.left),
        top: parsePercent(point.top),
        direction: index % 2 === 0 ? "right" : "down",
        sprite: CHARACTER_SHEETS[(index + 2) % CHARACTER_SHEETS.length] ?? FALLBACK_CHARACTER_SHEET,
      };
    });
}

export function PixelOfficeCanvas({
  zones,
  selectedAgentId,
  selectedZoneId,
  recentEvents = [],
  onSelectAgent,
  onSelectZone,
}: PixelOfficeCanvasProps) {
  const buildingRef = useRef<HTMLDivElement | null>(null);
  const frameHandleRef = useRef<number | null>(null);
  const timeoutHandleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragClickSuppressRef = useRef<string | null>(null);
  const dragStateRef = useRef<DragState | null>(null);

  const selectedZone = selectedZoneId ? zones.find((zone) => zone.zoneId === selectedZoneId) ?? null : null;
  const selectedAgent = selectedAgentId
    ? zones.flatMap((zone) => zone.agents).find((agent) => agent.agentId === selectedAgentId) ?? null
    : null;

  const seats = useMemo<StageSeat[]>(
    () =>
      BUILDING_ROOMS.flatMap((room) =>
        room.seats.map((seat, index) => ({
          seatId: seatIdFor(room.zoneId, index),
          zoneId: room.zoneId,
          left: seat.left,
          top: seat.top,
          point: { left: parsePercent(seat.left), top: parsePercent(seat.top) },
          direction: seat.direction,
        })),
      ),
    [],
  );

  const seatMap = useMemo(() => new Map(seats.map((seat) => [seat.seatId, seat])), [seats]);

  const [seatAssignments, setSeatAssignments] = useState<Record<string, string>>({});
  const [animatedAgents, setAnimatedAgents] = useState<AnimatedAgent[]>([]);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [commandMarker, setCommandMarker] = useState<Point | null>(null);

  useEffect(() => {
    dragStateRef.current = dragState;
  }, [dragState]);

  useEffect(() => {
    setSeatAssignments((current) => {
      const next: Record<string, string> = {};
      const usedSeats = new Set<string>();
      const allAgents = zones.flatMap((zone) => zone.agents);

      for (const agent of allAgents) {
        const existingSeat = current[agent.agentId];
        const existingSeatDef = existingSeat ? seatMap.get(existingSeat) : undefined;
        if (existingSeatDef && existingSeatDef.zoneId === agent.zoneId && !usedSeats.has(existingSeatDef.seatId)) {
          next[agent.agentId] = existingSeatDef.seatId;
          usedSeats.add(existingSeatDef.seatId);
        }
      }

      for (const zone of zones) {
        const zoneSeats = seats.filter((seat) => seat.zoneId === zone.zoneId);
        for (const agent of zone.agents) {
          if (next[agent.agentId]) {
            continue;
          }
          const availableSeat =
            zoneSeats.find((seat) => !usedSeats.has(seat.seatId)) ??
            seats.find((seat) => !usedSeats.has(seat.seatId)) ??
            zoneSeats[0];
          if (!availableSeat) {
            continue;
          }
          next[agent.agentId] = availableSeat.seatId;
          usedSeats.add(availableSeat.seatId);
        }
      }

      return next;
    });
  }, [seatMap, seats, zones]);

  const stageAgents = useMemo(() => {
    const placements: StageAgent[] = [];
    let spriteIndex = 0;

    for (const zone of zones) {
      for (const agent of zone.agents) {
        const seat = seatMap.get(seatAssignments[agent.agentId] ?? "") ?? seats.find((entry) => entry.zoneId === zone.zoneId);
        const room = ROOM_MAP.get(seat?.zoneId ?? zone.zoneId) ?? ROOM_MAP.get(zone.zoneId);
        if (!seat || !room) {
          continue;
        }

        placements.push({
          ...agent,
          seatId: seat.seatId,
          seat: seat.point,
          roomZoneId: room.zoneId,
          roomDoor: toPoint(room.door),
          roomWanderSpots: room.wanderSpots.map(toPoint),
          direction: seat.direction,
          sprite: CHARACTER_SHEETS[spriteIndex % CHARACTER_SHEETS.length] ?? FALLBACK_CHARACTER_SHEET,
        });
        spriteIndex += 1;
      }
    }

    return placements;
  }, [seatAssignments, seatMap, seats, zones]);

  const occupancyBySeat = useMemo(() => {
    const occupancy = new Map<string, string>();
    for (const agent of stageAgents) {
      occupancy.set(agent.seatId, agent.agentId);
    }
    return occupancy;
  }, [stageAgents]);

  const activeScreensByRoom = useMemo(() => {
    const roomCounts = new Map<OfficeZoneId, number>();
    for (const agent of stageAgents) {
      if (agent.activeSessions > 0 || agent.urgency === "active") {
        roomCounts.set(agent.roomZoneId, (roomCounts.get(agent.roomZoneId) ?? 0) + 1);
      }
    }
    return roomCounts;
  }, [stageAgents]);

  const ambientSubagents = useMemo(() => buildAmbientSubagents(recentEvents), [recentEvents]);

  useEffect(() => {
    setAnimatedAgents((current) => {
      const currentMap = new Map(current.map((agent) => [agent.agentId, agent]));
      return stageAgents.map((agent) => {
        const existing = currentMap.get(agent.agentId);
        if (!existing) {
          return {
            ...agent,
            left: agent.seat.left,
            top: agent.seat.top,
            motion: agent.activeSessions > 0 || agent.urgency === "active" ? "typing" : "idle",
            bubbleType: getBubbleType(agent),
            route: [],
            pauseUntil: 0,
            intent: "auto",
            commandExpiresAt: 0,
          };
        }

        return {
          ...existing,
          ...agent,
          seatId: agent.seatId,
          seat: agent.seat,
          roomZoneId: agent.roomZoneId,
          roomDoor: agent.roomDoor,
          roomWanderSpots: agent.roomWanderSpots,
          sprite: agent.sprite,
          bubbleType: getBubbleType(agent),
        };
      });
    });
  }, [stageAgents]);

  useEffect(() => {
    let lastTime = performance.now();
    const scheduleFrame = (callback: (time: number) => void) => {
      if (typeof globalThis.requestAnimationFrame === "function") {
        frameHandleRef.current = globalThis.requestAnimationFrame(callback);
        return;
      }
      timeoutHandleRef.current = globalThis.setTimeout(() => callback(performance.now()), 16);
    };

    const clearScheduledFrame = () => {
      if (frameHandleRef.current !== null && typeof globalThis.cancelAnimationFrame === "function") {
        globalThis.cancelAnimationFrame(frameHandleRef.current);
      }
      if (timeoutHandleRef.current !== null) {
        globalThis.clearTimeout(timeoutHandleRef.current);
      }
      frameHandleRef.current = null;
      timeoutHandleRef.current = null;
    };

    const tick = (time: number) => {
      const dt = Math.min((time - lastTime) / 1000, FRAME_STEP_LIMIT_SEC);
      const nowSeconds = time / 1000;
      lastTime = time;

      setAnimatedAgents((current) => current.map((agent) => updateAnimatedAgent(agent, dt, nowSeconds)));
      scheduleFrame(tick);
    };

    scheduleFrame(tick);
    return () => clearScheduledFrame();
  }, []);

  useEffect(() => {
    if (!dragState) {
      return undefined;
    }
    if (typeof window === "undefined") {
      return undefined;
    }

    const readPointFromClient = (clientX: number, clientY: number): Point | null => {
      const bounds = buildingRef.current?.getBoundingClientRect();
      if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
        return null;
      }
      return {
        left: clamp(((clientX - bounds.left) / bounds.width) * 100, 0, 100),
        top: clamp(((clientY - bounds.top) / bounds.height) * 100, 0, 100),
      };
    };

    const handlePointerMove = (event: PointerEvent) => {
      setDragState((current) => {
        if (!current || current.agentId !== dragState.agentId) {
          return current;
        }
        const point = readPointFromClient(event.clientX, event.clientY);
        const active =
          current.active ||
          Math.hypot(event.clientX - current.startClientX, event.clientY - current.startClientY) >= DRAG_THRESHOLD_PX;
        const nextState = {
          ...current,
          clientX: event.clientX,
          clientY: event.clientY,
          point,
          active,
        };
        dragStateRef.current = nextState;
        return nextState;
      });
    };

    const handlePointerUp = () => {
      const current = dragStateRef.current;
      if (current?.active) {
        const draggedAgent = stageAgents.find((agent) => agent.agentId === current.agentId);
        if (draggedAgent && current.point) {
          const targetSeat = seats
            .filter((seat) => seat.zoneId === draggedAgent.zoneId)
            .sort((leftSeat, rightSeat) => distanceBetween(leftSeat.point, current.point!) - distanceBetween(rightSeat.point, current.point!))[0];

          if (targetSeat && distanceBetween(targetSeat.point, current.point) <= SEAT_DROP_RADIUS) {
            setSeatAssignments((assignments) => {
              const next = { ...assignments };
              const currentSeatId = next[draggedAgent.agentId];
              const swappedAgentId = occupancyBySeat.get(targetSeat.seatId);
              next[draggedAgent.agentId] = targetSeat.seatId;
              if (swappedAgentId && swappedAgentId !== draggedAgent.agentId && currentSeatId) {
                next[swappedAgentId] = currentSeatId;
                const swapSeat = seatMap.get(currentSeatId);
                if (swapSeat) {
                  setAnimatedAgents((agents) =>
                    agents.map((agent) =>
                      agent.agentId === swappedAgentId
                        ? {
                            ...agent,
                            route: buildRouteBetweenPoints(agent, swapSeat.point),
                            intent: "seat",
                            pauseUntil: 0,
                            commandExpiresAt: 0,
                          }
                        : agent,
                    ),
                  );
                }
              }
              return next;
            });

            setAnimatedAgents((agents) =>
              agents.map((agent) =>
                agent.agentId === draggedAgent.agentId
                  ? {
                      ...agent,
                      route: buildRouteBetweenPoints(agent, targetSeat.point),
                      intent: "seat",
                      pauseUntil: 0,
                      commandExpiresAt: 0,
                    }
                  : agent,
              ),
            );
          } else {
            setAnimatedAgents((agents) =>
              agents.map((agent) =>
                agent.agentId === draggedAgent.agentId
                  ? {
                      ...agent,
                      route: buildRouteBetweenPoints(agent, current.point!),
                      intent: "command",
                      pauseUntil: 0,
                      commandExpiresAt: 0,
                    }
                  : agent,
              ),
            );
            setCommandMarker(current.point);
          }
        }

        dragClickSuppressRef.current = current.agentId;
      }
      dragStateRef.current = null;
      setDragState(null);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [dragState?.agentId, occupancyBySeat, seatMap, seats, stageAgents]);

  useEffect(() => {
    if (!commandMarker) {
      return undefined;
    }
    const timeout = globalThis.setTimeout(() => setCommandMarker(null), 1150);
    return () => globalThis.clearTimeout(timeout);
  }, [commandMarker]);

  const handleRoomKey = (event: KeyboardEvent<HTMLDivElement>, zoneId: OfficeZoneId) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelectZone(zoneId);
    }
  };

  const hoveredSeatId = useMemo(() => {
    if (!dragState?.active || !dragState.point) {
      return null;
    }
    const draggedAgent = stageAgents.find((agent) => agent.agentId === dragState.agentId);
    if (!draggedAgent) {
      return null;
    }
    const targetSeat = seats
      .filter((seat) => seat.zoneId === draggedAgent.zoneId)
      .sort((leftSeat, rightSeat) => distanceBetween(leftSeat.point, dragState.point!) - distanceBetween(rightSeat.point, dragState.point!))[0];
    if (!targetSeat || distanceBetween(targetSeat.point, dragState.point) > SEAT_DROP_RADIUS) {
      return null;
    }
    return targetSeat.seatId;
  }, [dragState, seats, stageAgents]);

  const sendSelectedAgentToPoint = (clientX: number, clientY: number) => {
    if (!selectedAgentId) {
      return;
    }
    const bounds = buildingRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
      return;
    }

    const point: Point = {
      left: clamp(((clientX - bounds.left) / bounds.width) * 100, 0, 100),
      top: clamp(((clientY - bounds.top) / bounds.height) * 100, 0, 100),
    };

    setAnimatedAgents((agents) =>
      agents.map((agent) =>
        agent.agentId === selectedAgentId
          ? {
              ...agent,
              route: buildRouteBetweenPoints(agent, point),
              intent: "command",
              pauseUntil: 0,
              commandExpiresAt: 0,
            }
          : agent,
      ),
    );
    setCommandMarker(point);
  };

  const cameraTarget = dragState?.active
    ? dragState.point
    : animatedAgents.find((agent) => agent.agentId === selectedAgentId) ?? null;

  const cameraTransform = useMemo(() => {
    if (!cameraTarget) {
      return "translate3d(0, 0, 0) scale(1)";
    }
    const xOffset = clamp(50 - cameraTarget.left, -CAMERA_TRANSLATE_LIMIT, CAMERA_TRANSLATE_LIMIT);
    const yOffset = clamp(50 - cameraTarget.top, -CAMERA_TRANSLATE_LIMIT, CAMERA_TRANSLATE_LIMIT);
    return `translate3d(${xOffset}%, ${yOffset}%, 0) scale(1.04)`;
  }, [cameraTarget]);

  const visibleSeats = useMemo(() => {
    const focusZoneId = dragState?.active
      ? stageAgents.find((agent) => agent.agentId === dragState.agentId)?.zoneId
      : selectedAgent?.zoneId;
    return focusZoneId ? seats.filter((seat) => seat.zoneId === focusZoneId) : [];
  }, [dragState, seats, selectedAgent?.zoneId, stageAgents]);

  return (
    <div className="pixel-office">
      <div className="pixel-office-stage">
        <div className="pixel-office-building" ref={buildingRef}>
          <div className="pixel-office-viewport">
            <div className="pixel-office-world" style={{ transform: cameraTransform }}>
              {HALLWAYS.map((hallway, index) => (
                <div
                  key={`${hallway.left}:${hallway.top}:${index}`}
                  className={`pixel-office-corridor${hallway.className ? ` ${hallway.className}` : ""}`}
                  style={{ left: hallway.left, top: hallway.top, width: hallway.width, height: hallway.height }}
                  onClick={(event) => {
                    if (!selectedAgentId) {
                      return;
                    }
                    event.stopPropagation();
                    sendSelectedAgentToPoint(event.clientX, event.clientY);
                  }}
                  aria-hidden="true"
                />
              ))}

              {BUILDING_ROOMS.map((room) => {
                const zone = zones.find((entry) => entry.zoneId === room.zoneId);
                let screenIndex = 0;
                return (
                  <div
                    key={room.zoneId}
                    className={[
                      `pixel-office-room pixel-office-room-${room.floor}`,
                      selectedZoneId === room.zoneId && !selectedAgent ? "is-selected" : "",
                      zone?.activeAgents ? "is-live" : "",
                      zone?.pendingApprovalCount ? "is-alert" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    style={{ left: room.left, top: room.top, width: room.width, height: room.height }}
                    onClick={(event: ReactMouseEvent<HTMLDivElement>) => {
                      event.stopPropagation();
                      if (selectedAgentId) {
                        sendSelectedAgentToPoint(event.clientX, event.clientY);
                        return;
                      }
                      onSelectZone(room.zoneId);
                    }}
                    onKeyDown={(event) => handleRoomKey(event, room.zoneId)}
                    tabIndex={0}
                    role="button"
                    aria-label={zone?.label ?? room.zoneId}
                  >
                    <div className="pixel-office-room-header">
                      <strong>{zone?.label ?? room.zoneId}</strong>
                    </div>
                    {room.furniture.map((item, index) => {
                      const isScreen = item.className?.includes("pixel-office-screen") ?? false;
                      const isLiveScreen = isScreen && screenIndex < (activeScreensByRoom.get(room.zoneId) ?? 0);
                      if (isScreen) {
                        screenIndex += 1;
                      }
                      return (
                        <img
                          key={`${room.zoneId}:${index}:${item.src}`}
                          src={item.src}
                          alt=""
                          aria-hidden="true"
                          className={`pixel-office-furniture${item.className ? ` ${item.className}` : ""}${isLiveScreen ? " is-live" : ""}`}
                          style={{ left: item.left, top: item.top, width: item.width, zIndex: item.zIndex ?? 1 }}
                        />
                      );
                    })}
                  </div>
                );
              })}

              {visibleSeats.map((seat) => {
                const occupiedBy = occupancyBySeat.get(seat.seatId);
                const isAssigned = selectedAgentId != null && seatAssignments[selectedAgentId] === seat.seatId;
                const isDropTarget = hoveredSeatId === seat.seatId;
                return (
                  <button
                    key={seat.seatId}
                    type="button"
                    className={[
                      "pixel-office-seat-marker",
                      occupiedBy ? "is-occupied" : "",
                      isAssigned ? "is-assigned" : "",
                      isDropTarget ? "is-target" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    style={{ left: seat.left, top: seat.top }}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (!selectedAgentId) {
                        return;
                      }
                      const selectedSeatId = seatAssignments[selectedAgentId];
                      const swappedAgentId = occupancyBySeat.get(seat.seatId);
                      setSeatAssignments((current) => {
                        const next = { ...current };
                        next[selectedAgentId] = seat.seatId;
                        if (swappedAgentId && swappedAgentId !== selectedAgentId && selectedSeatId) {
                          next[swappedAgentId] = selectedSeatId;
                        }
                        return next;
                      });
                      setAnimatedAgents((agents) =>
                        agents.map((agent) => {
                          if (agent.agentId === selectedAgentId) {
                            return {
                              ...agent,
                              route: buildRouteBetweenPoints(agent, seat.point),
                              intent: "seat",
                              pauseUntil: 0,
                              commandExpiresAt: 0,
                            };
                          }
                          if (swappedAgentId && agent.agentId === swappedAgentId) {
                            const swappedSeat = selectedSeatId ? seatMap.get(selectedSeatId) : undefined;
                            if (!swappedSeat) {
                              return agent;
                            }
                            return {
                              ...agent,
                              route: buildRouteBetweenPoints(agent, swappedSeat.point),
                              intent: "seat",
                              pauseUntil: 0,
                              commandExpiresAt: 0,
                            };
                          }
                          return agent;
                        }),
                      );
                    }}
                    aria-label={occupiedBy ? "Occupied seat" : "Available seat"}
                  />
                );
              })}

              {ambientSubagents.map((agent) => (
                <div
                  key={agent.eventId}
                  className="pixel-office-agent is-subagent is-idle"
                  style={{ left: `${agent.left}%`, top: `${agent.top}%` }}
                  aria-hidden="true"
                >
                  <span className="pixel-office-agent-bubble pixel-office-agent-bubble-waiting">+</span>
                  <span
                    className={`pixel-office-agent-sprite pixel-office-agent-sprite-${agent.direction}`}
                    style={{ backgroundImage: `url(${agent.sprite})` }}
                  />
                  <span className="pixel-office-agent-name">{agent.name}</span>
                </div>
              ))}

              {animatedAgents
                .filter((agent) => !(dragState?.active && dragState.agentId === agent.agentId))
                .map((agent) => (
                  <button
                    key={agent.agentId}
                    type="button"
                    className={[
                      `pixel-office-agent pixel-office-agent-${agent.urgency}`,
                      `is-${agent.motion}`,
                      agent.bubbleType ? `has-${agent.bubbleType}` : "",
                      selectedAgentId === agent.agentId ? "is-selected" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    style={{ left: `${agent.left}%`, top: `${agent.top}%` }}
                    onPointerDown={(event: ReactPointerEvent<HTMLButtonElement>) => {
                      const nextDragState = {
                        agentId: agent.agentId,
                        startClientX: event.clientX,
                        startClientY: event.clientY,
                        clientX: event.clientX,
                        clientY: event.clientY,
                        point: null,
                        active: false,
                      };
                      dragStateRef.current = nextDragState;
                      setDragState(nextDragState);
                    }}
                    onClick={(event) => {
                      if (dragClickSuppressRef.current === agent.agentId) {
                        dragClickSuppressRef.current = null;
                        event.preventDefault();
                        event.stopPropagation();
                        return;
                      }
                      event.stopPropagation();
                      onSelectAgent(agent.agentId, agent.zoneId);
                    }}
                    title={agent.latestAction}
                  >
                    {agent.bubbleType ? (
                      <span className={`pixel-office-agent-bubble pixel-office-agent-bubble-${agent.bubbleType}`}>
                        {agent.bubbleType === "permission" ? "..." : "ok"}
                      </span>
                    ) : null}
                    <span
                      className={`pixel-office-agent-sprite pixel-office-agent-sprite-${agent.direction}`}
                      style={{ backgroundImage: `url(${agent.sprite})` }}
                      aria-hidden="true"
                    />
                    <span className="pixel-office-agent-name">{agent.name}</span>
                  </button>
                ))}

              {dragState?.active && dragState.point ? (
                <div
                  className="pixel-office-agent is-selected is-dragging is-walking"
                  style={{ left: `${dragState.point.left}%`, top: `${dragState.point.top}%` }}
                  aria-hidden="true"
                >
                  {animatedAgents
                    .filter((agent) => agent.agentId === dragState.agentId)
                    .map((agent) => (
                      <div key={agent.agentId}>
                        <span className="pixel-office-agent-bubble pixel-office-agent-bubble-waiting">go</span>
                        <span
                          className={`pixel-office-agent-sprite pixel-office-agent-sprite-${agent.direction}`}
                          style={{ backgroundImage: `url(${agent.sprite})` }}
                        />
                        <span className="pixel-office-agent-name">{agent.name}</span>
                      </div>
                    ))}
                </div>
              ) : null}

              {commandMarker ? (
                <div
                  className="pixel-office-command-marker"
                  style={{ left: `${commandMarker.left}%`, top: `${commandMarker.top}%` }}
                  aria-hidden="true"
                />
              ) : null}
            </div>
          </div>
        </div>

        <div className="pixel-office-readout">
          <div>
            <p className="pixel-office-kicker">Citadel One</p>
            <strong>{selectedAgent ? `${selectedAgent.name} in ${selectedAgent.zoneLabel}` : selectedZone?.label ?? "Multi-Room Building"}</strong>
          </div>
          <p>
            {selectedAgent
              ? "Click any hallway or room to send the selected operator. Drag a sprite onto a seat to reassign that desk."
              : selectedZone?.leadAction ?? "Select a room or agent to inspect live work inside the first building."}
          </p>
        </div>
      </div>

      <div className="pixel-office-sidebar">
        <div className="pixel-office-panel" aria-label="Building summary">
          <p className="pixel-office-kicker">Building</p>
          <div className="pixel-office-building-meta">
            <strong>Citadel One</strong>
            <span>{zones.reduce((sum, zone) => sum + zone.agents.length, 0)} crew on-site</span>
            <span>{zones.reduce((sum, zone) => sum + zone.pendingApprovalCount, 0)} approvals in flight</span>
          </div>
        </div>

        <div className="pixel-office-panel" aria-label="Deck list">
          <p className="pixel-office-kicker">Decks</p>
          <div className="pixel-office-deck-list">
            {zones.map((zone) => (
              <button
                key={zone.zoneId}
                type="button"
                className={`pixel-office-deck${selectedZoneId === zone.zoneId ? " is-selected" : ""}`}
                onClick={() => onSelectZone(zone.zoneId)}
              >
                <strong>{zone.label}</strong>
                <span>{zone.activeAgents} active</span>
                <span>{zone.pendingApprovalCount} approvals</span>
              </button>
            ))}
          </div>
        </div>

        <div className="pixel-office-panel" aria-label="Crew list">
          <p className="pixel-office-kicker">Crew</p>
          <div className="pixel-office-crew-list">
            {zones.flatMap((zone) => zone.agents).map((agent) => (
              <button
                key={agent.agentId}
                type="button"
                className={`pixel-office-crew${selectedAgentId === agent.agentId ? " is-selected" : ""}`}
                onClick={() => onSelectAgent(agent.agentId, agent.zoneId)}
              >
                <strong>{agent.name}</strong>
                <span>{agent.zoneLabel}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
