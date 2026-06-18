import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { RealtimeEvent } from "../api/client";
import type { OfficeZoneId } from "../data/office-zones";
import {
  CAMERA_FOLLOW_LERP,
  CAMERA_FOLLOW_SNAP_THRESHOLD,
  TILE_SIZE,
  ZOOM_MAX,
  ZOOM_MIN,
} from "../pixel-office/constants";
import { loadPixelOfficeRuntimeAssets, supportsPixelOfficeRuntime } from "../pixel-office/assetLoader";
import { startGameLoop } from "../pixel-office/engine/gameLoop";
import { OfficeState } from "../pixel-office/engine/officeState";
import { renderFrame, type SelectionRenderState } from "../pixel-office/engine/renderer";

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

export type PixelOfficeCanvasCommand = {
  agentId: string;
  agentName: string;
  zoneId: OfficeZoneId;
  zoneLabel: string;
  kind: "move" | "reassign_seat" | "return_to_seat";
  targetLabel: string;
  summary: string;
  issuedAt: string;
};

type PixelOfficeCanvasProps = {
  zones: CanvasZone[];
  selectedAgentId: string | null;
  selectedZoneId: OfficeZoneId | null;
  selectedAgentReadoutOverride?: string | null;
  recentEvents?: RealtimeEvent[];
  onSelectAgent: (agentId: string, zoneId: OfficeZoneId) => void;
  onSelectZone: (zoneId: OfficeZoneId) => void;
  onAgentCommand?: (command: PixelOfficeCanvasCommand) => void;
};

type ScreenWorldPosition = {
  worldX: number;
  worldY: number;
  deviceX: number;
  deviceY: number;
};

type PointerDrag = {
  agentId: number;
  startX: number;
  startY: number;
  active: boolean;
};

const ZONE_TOOL_MAP: Record<OfficeZoneId, string | null> = {
  command: "Task",
  build: "Bash",
  operations: "Grep",
  research: "Read",
  security: "WebSearch",
};

const DRAG_THRESHOLD_PX = 8;
const DEFAULT_ZOOM = 2;

export function PixelOfficeCanvas({
  zones,
  selectedAgentId,
  selectedZoneId,
  selectedAgentReadoutOverride,
  recentEvents,
  onSelectAgent,
  onSelectZone,
  onAgentCommand,
}: PixelOfficeCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const officeStateRef = useRef<OfficeState | null>(null);
  const panRef = useRef({ x: 0, y: 0 });
  const offsetRef = useRef({ x: 0, y: 0 });
  const zoomRef = useRef(DEFAULT_ZOOM);
  const pointerDragRef = useRef<PointerDrag | null>(null);
  const agentIdMapRef = useRef(new Map<string, number>());
  const reverseAgentMapRef = useRef(new Map<number, CanvasAgent>());
  const nextNumericIdRef = useRef(1);

  const [isReady, setIsReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const runtimeSupported = supportsPixelOfficeRuntime();

  const agents = useMemo(
    () =>
      zones
        .flatMap((zone) => zone.agents)
        .slice()
        .sort((left, right) => left.agentId.localeCompare(right.agentId)),
    [zones],
  );

  const selectedZone = useMemo(
    () => zones.find((zone) => zone.zoneId === selectedZoneId) ?? zones[0] ?? null,
    [selectedZoneId, zones],
  );

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.agentId === selectedAgentId) ?? null,
    [agents, selectedAgentId],
  );

  useEffect(() => {
    let isCancelled = false;
    if (!runtimeSupported) {
      setIsReady(false);
      setLoadError(null);
      return () => {
        isCancelled = true;
      };
    }
    void loadPixelOfficeRuntimeAssets()
      .then(({ defaultLayout }) => {
        if (isCancelled) {
          return;
        }
        officeStateRef.current = new OfficeState(defaultLayout);
        setIsReady(true);
        setLoadError(null);
      })
      .catch((error) => {
        if (isCancelled) {
          return;
        }
        setLoadError((error as Error).message);
      });
    return () => {
      isCancelled = true;
    };
  }, [runtimeSupported]);

  useEffect(() => {
    const officeState = officeStateRef.current;
    if (!officeState || !isReady) {
      return;
    }

    const activeNumericIds = new Set<number>();
    const reverse = new Map<number, CanvasAgent>();

    for (const agent of agents) {
      let numericId = agentIdMapRef.current.get(agent.agentId);
      if (numericId == null) {
        numericId = nextNumericIdRef.current;
        nextNumericIdRef.current += 1;
        agentIdMapRef.current.set(agent.agentId, numericId);
      }
      reverse.set(numericId, agent);
      activeNumericIds.add(numericId);

      if (!officeState.characters.has(numericId)) {
        officeState.addAgent(numericId);
      }

      officeState.setAgentActive(numericId, agent.activeSessions > 0 || agent.urgency === "active");
      officeState.setAgentTool(numericId, ZONE_TOOL_MAP[agent.zoneId] ?? null);

      if (agent.pendingApprovalCount > 0) {
        officeState.showPermissionBubble(numericId);
      } else {
        officeState.clearPermissionBubble(numericId);
      }
    }

    reverseAgentMapRef.current = reverse;

    for (const character of officeState.getCharacters()) {
      if (character.id < 0 || activeNumericIds.has(character.id)) {
        continue;
      }
      officeState.removeAgent(character.id);
    }

    // F-M14: prune the agentId → numericId map for agents that are no longer
    // present. Without this the map (and the reverse map above) grow
    // monotonically as agent IDs churn, since `removeAgent` only clears the
    // office-state character, never the id mapping. Deleting stale entries
    // bounds both maps to the live agent set.
    for (const knownAgentId of agentIdMapRef.current.keys()) {
      const numericId = agentIdMapRef.current.get(knownAgentId);
      if (numericId == null || !activeNumericIds.has(numericId)) {
        agentIdMapRef.current.delete(knownAgentId);
      }
    }
  }, [agents, isReady]);

  useEffect(() => {
    const officeState = officeStateRef.current;
    if (!officeState) {
      return;
    }

    const numericId = selectedAgentId ? (agentIdMapRef.current.get(selectedAgentId) ?? null) : null;
    officeState.selectedAgentId = numericId;
    officeState.cameraFollowId = numericId;
  }, [isReady, selectedAgentId]);

  useEffect(() => {
    const officeState = officeStateRef.current;
    if (!officeState) {
      return;
    }

    const seenKeys = new Set<string>();
    for (const event of recentEvents ?? []) {
      if (event.eventType !== "subagent_registered") {
        continue;
      }
      const parentAgentToken = extractStringHint(event.payload, ["agentId", "parentAgentId", "runtimeAgentId"]);
      if (!parentAgentToken) {
        continue;
      }
      const parentNumericId = agentIdMapRef.current.get(parentAgentToken);
      if (parentNumericId == null) {
        continue;
      }
      const toolId = extractStringHint(event.payload, ["toolId", "subagentId", "taskId"]) ?? event.eventId;
      const key = `${parentNumericId}:${toolId}`;
      if (seenKeys.has(key)) {
        continue;
      }
      seenKeys.add(key);
      if (officeState.getSubagentId(parentNumericId, toolId) == null) {
        officeState.addSubagent(parentNumericId, toolId);
      }
    }
  }, [isReady, recentEvents]);

  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    const officeState = officeStateRef.current;
    if (!canvas || !container || !officeState) {
      return;
    }

    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;

    const layout = officeState.getLayout();
    const fitZoom = Math.max(
      ZOOM_MIN,
      Math.min(
        ZOOM_MAX,
        Math.floor(
          Math.min(
            canvas.width / Math.max(layout.cols * TILE_SIZE, 1),
            canvas.height / Math.max(layout.rows * TILE_SIZE, 1),
          ),
        ),
      ),
    );
    const nextZoom = Number.isFinite(fitZoom) && fitZoom > 0 ? fitZoom : DEFAULT_ZOOM;
    zoomRef.current = nextZoom;
    setZoom(nextZoom);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    const officeState = officeStateRef.current;
    if (!canvas || !container || !officeState || !isReady) {
      return;
    }

    resizeCanvas();
    const observer = new ResizeObserver(() => resizeCanvas());
    observer.observe(container);

    const stop = startGameLoop(canvas, {
      update: (dt) => {
        officeState.update(dt);
      },
      render: (ctx) => {
        const zoomLevel = zoomRef.current;
        if (officeState.cameraFollowId !== null) {
          const followCharacter = officeState.characters.get(officeState.cameraFollowId);
          if (followCharacter) {
            const layout = officeState.getLayout();
            const mapWidth = layout.cols * TILE_SIZE * zoomLevel;
            const mapHeight = layout.rows * TILE_SIZE * zoomLevel;
            const targetX = mapWidth / 2 - followCharacter.x * zoomLevel;
            const targetY = mapHeight / 2 - followCharacter.y * zoomLevel;
            const deltaX = targetX - panRef.current.x;
            const deltaY = targetY - panRef.current.y;

            if (Math.abs(deltaX) < CAMERA_FOLLOW_SNAP_THRESHOLD && Math.abs(deltaY) < CAMERA_FOLLOW_SNAP_THRESHOLD) {
              panRef.current = { x: targetX, y: targetY };
            } else {
              panRef.current = {
                x: panRef.current.x + deltaX * CAMERA_FOLLOW_LERP,
                y: panRef.current.y + deltaY * CAMERA_FOLLOW_LERP,
              };
            }
          }
        }

        const selectionRender: SelectionRenderState = {
          selectedAgentId: officeState.selectedAgentId,
          hoveredAgentId: officeState.hoveredAgentId,
          hoveredTile: officeState.hoveredTile,
          seats: officeState.seats,
          characters: officeState.characters,
        };

        const { offsetX, offsetY } = renderFrame(
          ctx,
          canvas.width,
          canvas.height,
          officeState.tileMap,
          officeState.furniture,
          officeState.getCharacters(),
          zoomLevel,
          panRef.current.x,
          panRef.current.y,
          selectionRender,
          undefined,
          officeState.layout.tileColors,
          officeState.layout.cols,
          officeState.layout.rows,
        );
        offsetRef.current = { x: offsetX, y: offsetY };
      },
    });

    return () => {
      stop();
      observer.disconnect();
    };
  }, [isReady, resizeCanvas]);

  const screenToWorld = useCallback((clientX: number, clientY: number): ScreenWorldPosition | null => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return null;
    }
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const deviceX = (clientX - rect.left) * dpr;
    const deviceY = (clientY - rect.top) * dpr;
    return {
      worldX: (deviceX - offsetRef.current.x) / zoomRef.current,
      worldY: (deviceY - offsetRef.current.y) / zoomRef.current,
      deviceX,
      deviceY,
    };
  }, []);

  const screenToTile = useCallback(
    (clientX: number, clientY: number) => {
      const officeState = officeStateRef.current;
      const pos = screenToWorld(clientX, clientY);
      if (!officeState || !pos) {
        return null;
      }
      const col = Math.floor(pos.worldX / TILE_SIZE);
      const row = Math.floor(pos.worldY / TILE_SIZE);
      const layout = officeState.getLayout();
      if (col < 0 || col >= layout.cols || row < 0 || row >= layout.rows) {
        return null;
      }
      return { col, row };
    },
    [screenToWorld],
  );

  const updateHoverState = useCallback(
    (event: ReactMouseEvent<HTMLCanvasElement>) => {
      const officeState = officeStateRef.current;
      const pos = screenToWorld(event.clientX, event.clientY);
      if (!officeState || !pos) {
        return;
      }

      const hitId = officeState.getCharacterAt(pos.worldX, pos.worldY);
      const tile = screenToTile(event.clientX, event.clientY);
      officeState.hoveredAgentId = hitId;
      officeState.hoveredTile = tile;

      const canvas = canvasRef.current;
      if (!canvas) {
        return;
      }

      let cursor = "default";
      if (hitId !== null) {
        cursor = "pointer";
      } else if (officeState.selectedAgentId !== null && tile) {
        const seatId = officeState.getSeatAtTile(tile.col, tile.row);
        if (seatId) {
          const seat = officeState.seats.get(seatId);
          const selectedCharacter = officeState.characters.get(officeState.selectedAgentId);
          if (seat && (!seat.assigned || selectedCharacter?.seatId === seatId)) {
            cursor = "pointer";
          }
        }
      }
      canvas.style.cursor = cursor;
    },
    [screenToTile, screenToWorld],
  );

  const selectNumericAgent = useCallback(
    (numericId: number | null) => {
      const officeState = officeStateRef.current;
      if (!officeState) {
        return;
      }

      officeState.selectedAgentId = numericId;
      officeState.cameraFollowId = numericId;

      if (numericId == null) {
        if (selectedZoneId) {
          onSelectZone(selectedZoneId);
        }
        return;
      }

      const agent = reverseAgentMapRef.current.get(numericId);
      if (agent) {
        onSelectAgent(agent.agentId, agent.zoneId);
      }
    },
    [onSelectAgent, onSelectZone, selectedZoneId],
  );

  const emitAgentCommand = useCallback(
    (numericId: number, kind: PixelOfficeCanvasCommand["kind"], targetLabel: string, summary: string) => {
      const agent = reverseAgentMapRef.current.get(numericId);
      if (!agent || !onAgentCommand) {
        return;
      }
      onAgentCommand({
        agentId: agent.agentId,
        agentName: agent.name,
        zoneId: agent.zoneId,
        zoneLabel: agent.zoneLabel,
        kind,
        targetLabel,
        summary,
        issuedAt: new Date().toISOString(),
      });
    },
    [onAgentCommand],
  );

  const commandAgentToTile = useCallback(
    (numericId: number, col: number, row: number) => {
      const officeState = officeStateRef.current;
      if (!officeState) {
        return false;
      }

      const agent = reverseAgentMapRef.current.get(numericId);
      const agentName = agent?.name ?? "agent";
      const zoneLabel = agent?.zoneLabel ?? "the current zone";

      const seatId = officeState.getSeatAtTile(col, row);
      if (seatId) {
        const seat = officeState.seats.get(seatId);
        const character = officeState.characters.get(numericId);
        if (seat && character) {
          if (character.seatId === seatId) {
            officeState.sendToSeat(numericId);
            emitAgentCommand(
              numericId,
              "return_to_seat",
              `seat ${seat.seatCol},${seat.seatRow}`,
              `Directed ${agentName} back to seat ${seat.seatCol},${seat.seatRow} in ${zoneLabel}.`,
            );
            return true;
          }
          if (!seat.assigned) {
            officeState.reassignSeat(numericId, seatId);
            emitAgentCommand(
              numericId,
              "reassign_seat",
              `seat ${seat.seatCol},${seat.seatRow}`,
              `Reassigned ${agentName} to seat ${seat.seatCol},${seat.seatRow} in ${zoneLabel}.`,
            );
            return true;
          }
        }
      }

      const moved = officeState.walkToTile(numericId, col, row);
      if (moved) {
        emitAgentCommand(
          numericId,
          "move",
          `tile ${col},${row}`,
          `Directed ${agentName} to tile ${col},${row} in ${zoneLabel}.`,
        );
      }
      return moved;
    },
    [emitAgentCommand],
  );

  const handleMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLCanvasElement>) => {
      if (event.button !== 0) {
        return;
      }

      const officeState = officeStateRef.current;
      const pos = screenToWorld(event.clientX, event.clientY);
      if (!officeState || !pos) {
        return;
      }

      const hitId = officeState.getCharacterAt(pos.worldX, pos.worldY);
      if (hitId !== null) {
        pointerDragRef.current = {
          agentId: hitId,
          startX: event.clientX,
          startY: event.clientY,
          active: false,
        };
      } else {
        pointerDragRef.current = null;
      }
    },
    [screenToWorld],
  );

  const handleMouseMove = useCallback(
    (event: ReactMouseEvent<HTMLCanvasElement>) => {
      updateHoverState(event);

      const drag = pointerDragRef.current;
      if (!drag) {
        return;
      }

      const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
      if (distance >= DRAG_THRESHOLD_PX) {
        drag.active = true;
        pointerDragRef.current = drag;
      }
    },
    [updateHoverState],
  );

  const handleMouseUp = useCallback(
    (event: ReactMouseEvent<HTMLCanvasElement>) => {
      const officeState = officeStateRef.current;
      const drag = pointerDragRef.current;
      pointerDragRef.current = null;
      if (!officeState) {
        return;
      }

      const pos = screenToWorld(event.clientX, event.clientY);
      const tile = screenToTile(event.clientX, event.clientY);
      if (!pos) {
        return;
      }

      if (drag) {
        if (drag.active) {
          if (tile) {
            commandAgentToTile(drag.agentId, tile.col, tile.row);
          }
          selectNumericAgent(drag.agentId);
          return;
        }

        const hitId = officeState.getCharacterAt(pos.worldX, pos.worldY);
        if (hitId === drag.agentId) {
          if (officeState.selectedAgentId === hitId) {
            selectNumericAgent(null);
          } else {
            officeState.dismissBubble(hitId);
            selectNumericAgent(hitId);
          }
          return;
        }
      }

      if (officeState.selectedAgentId !== null && tile) {
        if (commandAgentToTile(officeState.selectedAgentId, tile.col, tile.row)) {
          return;
        }
      }

      selectNumericAgent(null);
    },
    [commandAgentToTile, screenToTile, screenToWorld, selectNumericAgent],
  );

  const handleMouseLeave = useCallback(() => {
    pointerDragRef.current = null;
    const officeState = officeStateRef.current;
    if (!officeState) {
      return;
    }
    officeState.hoveredAgentId = null;
    officeState.hoveredTile = null;
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.style.cursor = "default";
    }
  }, []);

  const handleContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLCanvasElement>) => {
      event.preventDefault();
      const officeState = officeStateRef.current;
      if (!officeState || officeState.selectedAgentId == null) {
        return;
      }
      const tile = screenToTile(event.clientX, event.clientY);
      if (tile) {
        const moved = officeState.walkToTile(officeState.selectedAgentId, tile.col, tile.row);
        if (moved) {
          const agent = reverseAgentMapRef.current.get(officeState.selectedAgentId);
          emitAgentCommand(
            officeState.selectedAgentId,
            "move",
            `tile ${tile.col},${tile.row}`,
            `Directed ${agent?.name ?? "agent"} to tile ${tile.col},${tile.row} in ${agent?.zoneLabel ?? "the current zone"}.`,
          );
        }
      }
    },
    [emitAgentCommand, screenToTile],
  );

  return (
    <div className="pixel-office">
      <div className="pixel-office-stage">
        <div className="pixel-office-building pixel-office-canvas-shell" ref={containerRef}>
          {loadError ? (
            <div className="pixel-office-loading">{loadError}</div>
          ) : !runtimeSupported ? (
            <div className="pixel-office-loading">Pixel office preview is disabled in this test environment.</div>
          ) : !isReady ? (
            <div className="pixel-office-loading">Loading pixel office runtime…</div>
          ) : (
            <canvas
              ref={canvasRef}
              className="pixel-office-canvas"
              role="img"
              aria-label="Pixel office floor visualizing agent activity"
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseLeave}
              onContextMenu={handleContextMenu}
            />
          )}
        </div>
        <div className="pixel-office-readout">
          <div>
            <p className="pixel-office-kicker">Citadel One</p>
            <strong>{selectedAgent ? selectedAgent.name : (selectedZone?.label ?? "Office Floor")}</strong>
          </div>
          <p>
            {selectedAgent
              ? (selectedAgentReadoutOverride ?? selectedAgent.latestAction)
              : (selectedZone?.leadAction ??
                `Zoom ${zoom}x${recentEvents?.length ? ` • ${recentEvents.length} live events` : ""}`)}
          </p>
        </div>
        <div className="pixel-office-deck-strip" aria-label="Deck map">
          {zones.map((zone) => (
            <button
              key={zone.zoneId}
              type="button"
              className={["gc-button", `pixel-office-deck-chip${zone.zoneId === selectedZoneId ? " is-selected" : ""}`]
                .filter(Boolean)
                .join(" ")}
              onClick={() => onSelectZone(zone.zoneId)}
            >
              {zone.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function extractStringHint(payload: unknown, keys: string[]): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  for (const key of keys) {
    const value = (payload as Record<string, unknown>)[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return null;
}
