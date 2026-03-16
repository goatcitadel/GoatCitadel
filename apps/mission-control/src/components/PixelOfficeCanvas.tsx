import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { OfficeZoneId } from "../data/office-zones";

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
  onSelectAgent: (agentId: string, zoneId: OfficeZoneId) => void;
  onSelectZone: (zoneId: OfficeZoneId) => void;
};

type Seat = {
  left: string;
  top: string;
  direction: "down" | "up" | "right";
};

type Waypoint = {
  left: string;
  top: string;
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

type FurnitureDefinition = {
  src: string;
  left: string;
  top: string;
  width: string;
  zIndex?: number;
  className?: string;
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

type StageAgent = CanvasAgent & {
  sprite: string;
  seat: Point;
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

function pickRandom<T>(items: T[], fallback: T): T {
  if (items.length === 0) {
    return fallback;
  }
  return items[Math.floor(Math.random() * items.length)] ?? fallback;
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

  if (shouldWork) {
    next.route = [];
    const seatDistance = distanceBetween(next, next.seat);
    if (seatDistance <= 0.55) {
      next.left = next.seat.left;
      next.top = next.seat.top;
      next.motion = "typing";
      next.direction = agent.direction;
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

  if (next.route.length === 0 && nowSeconds >= next.pauseUntil) {
    next.route = buildIdleRoute(next);
  }

  if (next.route.length === 0) {
    next.motion = distanceBetween(next, next.seat) <= 0.6 ? "idle" : "walking";
    return next;
  }

  const target = next.route[0];
  if (!target) {
    next.motion = "idle";
    next.pauseUntil = nowSeconds + randomBetween(HALLWAY_DWELL_MIN_SEC, HALLWAY_DWELL_MAX_SEC);
    return next;
  }
  const remaining = distanceBetween(next, target);
  if (remaining <= 0.4) {
    next.left = target.left;
    next.top = target.top;
    next.route = next.route.slice(1);
    next.motion = next.route.length === 0 ? "idle" : "walking";
    next.pauseUntil = next.route.length === 0 ? nowSeconds + randomBetween(HALLWAY_DWELL_MIN_SEC, HALLWAY_DWELL_MAX_SEC) : next.pauseUntil;
    return next;
  }

  next.motion = "walking";
  next.direction = getDirection(next, target);
  const speed = target === next.seat ? IDLE_WALK_SPEED_PERCENT : WALK_SPEED_PERCENT;
  const step = Math.min((speed * dt) / remaining, 1);
  next.left = next.left + (target.left - next.left) * step;
  next.top = next.top + (target.top - next.top) * step;
  return next;
}

export function PixelOfficeCanvas({
  zones,
  selectedAgentId,
  selectedZoneId,
  onSelectAgent,
  onSelectZone,
}: PixelOfficeCanvasProps) {
  const selectedZone = selectedZoneId ? zones.find((zone) => zone.zoneId === selectedZoneId) ?? null : null;
  const selectedAgent = selectedAgentId
    ? zones.flatMap((zone) => zone.agents).find((agent) => agent.agentId === selectedAgentId) ?? null
    : null;

  const stageAgents = useMemo(() => {
    const placements: StageAgent[] = [];
    let spriteIndex = 0;

    for (const zone of zones) {
      const room = BUILDING_ROOMS.find((entry) => entry.zoneId === zone.zoneId);
      if (!room) {
        continue;
      }

      zone.agents.forEach((agent, index) => {
        const seat = room.seats[index % room.seats.length] ?? room.seats[0];
        if (!seat) {
          return;
        }

        placements.push({
          ...agent,
          seat: { left: parsePercent(seat.left), top: parsePercent(seat.top) },
          roomDoor: toPoint(room.door),
          roomWanderSpots: room.wanderSpots.map(toPoint),
          direction: seat.direction,
          sprite: CHARACTER_SHEETS[spriteIndex % CHARACTER_SHEETS.length] ?? FALLBACK_CHARACTER_SHEET,
        });
        spriteIndex += 1;
      });
    }

    return placements;
  }, [zones]);

  const [animatedAgents, setAnimatedAgents] = useState<AnimatedAgent[]>([]);
  const frameHandleRef = useRef<number | null>(null);
  const timeoutHandleRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
          };
        }

        return {
          ...existing,
          ...agent,
          seat: agent.seat,
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

  const handleRoomKey = (event: KeyboardEvent<HTMLDivElement>, zoneId: OfficeZoneId) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelectZone(zoneId);
    }
  };

  return (
    <div className="pixel-office">
      <div className="pixel-office-stage">
        <div className="pixel-office-building">
          {HALLWAYS.map((hallway, index) => (
            <div
              key={`${hallway.left}:${hallway.top}:${index}`}
              className={`pixel-office-corridor${hallway.className ? ` ${hallway.className}` : ""}`}
              style={{ left: hallway.left, top: hallway.top, width: hallway.width, height: hallway.height }}
              aria-hidden="true"
            />
          ))}
          {BUILDING_ROOMS.map((room) => {
            const zone = zones.find((entry) => entry.zoneId === room.zoneId);
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
                onClick={() => onSelectZone(room.zoneId)}
                onKeyDown={(event) => handleRoomKey(event, room.zoneId)}
                tabIndex={0}
                role="button"
                aria-label={zone?.label ?? room.zoneId}
              >
                <div className="pixel-office-room-header">
                  <strong>{zone?.label ?? room.zoneId}</strong>
                </div>
                {room.furniture.map((item, index) => (
                  <img
                    key={`${room.zoneId}:${index}:${item.src}`}
                    src={item.src}
                    alt=""
                    aria-hidden="true"
                    className={`pixel-office-furniture${item.className ? ` ${item.className}` : ""}`}
                    style={{ left: item.left, top: item.top, width: item.width, zIndex: item.zIndex ?? 1 }}
                  />
                ))}
              </div>
            );
          })}
          {animatedAgents.map((agent) => (
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
              onClick={(event) => {
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
        </div>
        <div className="pixel-office-readout">
          <div>
            <p className="pixel-office-kicker">Citadel One</p>
            <strong>{selectedAgent ? `${selectedAgent.name} in ${selectedAgent.zoneLabel}` : selectedZone?.label ?? "Multi-Room Building"}</strong>
          </div>
          <p>{selectedAgent?.latestAction ?? selectedZone?.leadAction ?? "Select a room or agent to inspect live work inside the first building."}</p>
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
        <div className="pixel-office-panel" aria-label="Office decks">
          <p className="pixel-office-kicker">Decks</p>
          <div className="pixel-office-deck-list">
            {zones.map((zone) => (
              <button
                key={zone.zoneId}
                type="button"
                className={`pixel-office-deck${selectedZoneId === zone.zoneId && !selectedAgent ? " is-selected" : ""}`}
                onClick={() => onSelectZone(zone.zoneId)}
              >
                <strong>{zone.label}</strong>
                <span>{zone.activeAgents} active</span>
                <span>{zone.pendingApprovalCount} approvals</span>
              </button>
            ))}
          </div>
        </div>
        <div className="pixel-office-panel" aria-label="Crew in focus">
          <p className="pixel-office-kicker">Crew</p>
          <div className="pixel-office-crew-list">
            {(selectedZone?.agents ?? zones.flatMap((zone) => zone.agents).slice(0, 8)).map((agent) => (
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
