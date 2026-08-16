import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { MessageSquareText, RotateCcw, SendHorizontal, X } from "lucide-react";
import type { ChatStreamingPreview, ChatThreadTurnRecord } from "@goatcitadel/contracts";
import type { MissionThreadedRenderSurfaceInput } from "@goatcitadel/threaded-surface-core";
import { useMediaQuery } from "@goatcitadel/mission-control-shared/hooks/useMediaQuery";

type ThreadedBtwSideChatProps = MissionThreadedRenderSurfaceInput["btwSideChatProps"];

export interface BtwSideChatPanelPosition {
  x: number;
  y: number;
}

interface BtwSideChatViewportSize {
  width: number;
  height: number;
}

interface BtwSideChatPanelSize {
  width: number;
  height: number;
}

interface BtwSideChatDragState {
  startClientX: number;
  startClientY: number;
  startPosition: BtwSideChatPanelPosition;
}

const STORAGE_KEY_PREFIX = "goatcitadel.chat.btw_side_chat.position.v1:";
const DEFAULT_PANEL_SIZE: BtwSideChatPanelSize = { width: 352, height: 430 };
const VIEWPORT_PADDING = 14;
const DESKTOP_RIGHT_OFFSET = 28;
const DESKTOP_BOTTOM_OFFSET = 104;

export function ThreadedBtwSideChatPanel({ sideChat }: { sideChat: ThreadedBtwSideChatProps }) {
  const compact = useMediaQuery("(max-width: 840px)");
  const panelRef = useRef<HTMLDivElement | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const dragRef = useRef<BtwSideChatDragState | null>(null);
  const latestPositionRef = useRef<BtwSideChatPanelPosition | null>(null);
  const [position, setPosition] = useState<BtwSideChatPanelPosition | null>(null);
  const [dragging, setDragging] = useState(false);

  const turns = sideChat?.thread?.turns ?? [];
  const parentTitle = sideChat?.parentTitle?.trim() || "Current chat";

  const panelSize = useCallback((): BtwSideChatPanelSize => {
    const rect = panelRef.current?.getBoundingClientRect();
    return {
      width: rect?.width && rect.width > 0 ? rect.width : DEFAULT_PANEL_SIZE.width,
      height: rect?.height && rect.height > 0 ? rect.height : DEFAULT_PANEL_SIZE.height,
    };
  }, []);

  const resolveDefaultPosition = useCallback(() => {
    if (typeof window === "undefined") {
      return { x: 0, y: 0 };
    }
    return getDefaultBtwSideChatPosition(getBtwSideChatViewportSize(), panelSize());
  }, [panelSize]);

  const setClampedPosition = useCallback(
    (next: BtwSideChatPanelPosition) => {
      if (typeof window === "undefined") {
        return;
      }
      const clamped = clampBtwSideChatPosition(next, getBtwSideChatViewportSize(), panelSize());
      latestPositionRef.current = clamped;
      setPosition(clamped);
    },
    [panelSize],
  );

  useEffect(() => {
    if (!sideChat?.open) {
      setDragging(false);
      dragRef.current = null;
      return;
    }
    inputRef.current?.focus();
  }, [sideChat?.open]);

  useEffect(() => {
    if (!sideChat?.open) {
      return;
    }
    const list = messageListRef.current;
    if (!list) {
      return;
    }
    list.scrollTop = list.scrollHeight;
  }, [sideChat?.open, sideChat?.sending, sideChat?.streamingPreview?.visibleText.length, turns.length]);

  useEffect(() => {
    if (!sideChat?.open) {
      return;
    }
    if (compact) {
      latestPositionRef.current = null;
      setPosition(null);
      return;
    }
    const stored = readBtwSideChatPosition(sideChat?.workspaceId ?? "default");
    const next = stored
      ? clampBtwSideChatPosition(stored, getBtwSideChatViewportSize(), panelSize())
      : resolveDefaultPosition();
    latestPositionRef.current = next;
    setPosition(next);
  }, [compact, panelSize, resolveDefaultPosition, sideChat?.open, sideChat?.workspaceId]);

  useEffect(() => {
    if (!sideChat?.open || compact) {
      return;
    }
    const eventTarget = window;
    const handleResize = () => {
      setClampedPosition(latestPositionRef.current ?? resolveDefaultPosition());
    };
    eventTarget.addEventListener("resize", handleResize);
    return () => eventTarget.removeEventListener("resize", handleResize);
  }, [compact, resolveDefaultPosition, setClampedPosition, sideChat?.open]);

  useEffect(() => {
    if (!dragging) {
      return;
    }
    const eventTarget = window;
    const handlePointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) {
        return;
      }
      event.preventDefault();
      const next = {
        x: drag.startPosition.x + event.clientX - drag.startClientX,
        y: drag.startPosition.y + event.clientY - drag.startClientY,
      };
      setClampedPosition(next);
    };
    const finishDrag = () => {
      setDragging(false);
      dragRef.current = null;
      const latest = latestPositionRef.current;
      if (latest && sideChat?.workspaceId) {
        writeBtwSideChatPosition(sideChat.workspaceId, latest);
      }
    };
    eventTarget.addEventListener("pointermove", handlePointerMove, { passive: false });
    eventTarget.addEventListener("pointerup", finishDrag);
    eventTarget.addEventListener("pointercancel", finishDrag);
    return () => {
      eventTarget.removeEventListener("pointermove", handlePointerMove);
      eventTarget.removeEventListener("pointerup", finishDrag);
      eventTarget.removeEventListener("pointercancel", finishDrag);
    };
  }, [dragging, setClampedPosition, sideChat?.workspaceId]);

  const handleHeaderPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (compact || event.button !== 0 || isBtwSideChatInteractiveTarget(event.target)) {
      return;
    }
    const startPosition = position ?? resolveDefaultPosition();
    dragRef.current = {
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPosition,
    };
    latestPositionRef.current = startPosition;
    setDragging(true);
    event.preventDefault();
  };

  const handleHeaderDoubleClick = () => {
    if (compact) {
      return;
    }
    const next = resolveDefaultPosition();
    if (sideChat?.workspaceId) {
      removeBtwSideChatPosition(sideChat.workspaceId);
    }
    latestPositionRef.current = next;
    setPosition(next);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    sideChat?.onSend();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }
    event.preventDefault();
    sideChat?.onSend();
  };

  const panelStyle = useMemo<CSSProperties | undefined>(() => {
    if (compact || !position) {
      return undefined;
    }
    return {
      left: `${position.x}px`,
      top: `${position.y}px`,
    };
  }, [compact, position]);

  if (!sideChat || !sideChat.open) {
    return null;
  }

  return (
    <aside
      ref={panelRef}
      className={`mc-next-btw-side-chat${dragging ? " dragging" : ""}${compact ? " compact" : ""}`}
      style={panelStyle}
      aria-label="Side chat"
      data-testid="btw-side-chat-panel"
    >
      <header
        className="mc-next-btw-side-chat-header"
        onPointerDown={handleHeaderPointerDown}
        onDoubleClick={handleHeaderDoubleClick}
      >
        <div className="mc-next-btw-side-chat-title">
          <MessageSquareText size={15} aria-hidden="true" />
          <div>
            <h2>Side chat</h2>
            <p>{parentTitle}</p>
          </div>
        </div>
        <div className="mc-next-btw-side-chat-actions">
          {!compact ? (
            <button
              type="button"
              className="mc-next-panel-button icon"
              aria-label="Reset side chat position"
              title="Reset position"
              onClick={handleHeaderDoubleClick}
            >
              <RotateCcw size={14} />
            </button>
          ) : null}
          <button
            type="button"
            className="mc-next-panel-button icon"
            aria-label="Close side chat"
            title="Close"
            onClick={sideChat.onClose}
          >
            <X size={14} />
          </button>
        </div>
      </header>

      <div ref={messageListRef} className="mc-next-btw-side-chat-body" aria-live="polite">
        {sideChat.loading && turns.length === 0 ? <p className="mc-next-btw-side-chat-status">Opening...</p> : null}
        {!sideChat.loading && turns.length === 0 ? <p className="mc-next-btw-side-chat-empty">No aside yet.</p> : null}
        {turns.map((turn) => (
          <BtwSideChatTurn
            key={turn.turnId}
            turn={turn}
            streamingPreview={sideChat.streamingPreview?.turnId === turn.turnId ? sideChat.streamingPreview : null}
          />
        ))}
        {sideChat.sending ? <p className="mc-next-btw-side-chat-status thinking">Thinking...</p> : null}
        {sideChat.error ? (
          <p className="mc-next-btw-side-chat-error" role="alert">
            {sideChat.error}
          </p>
        ) : null}
      </div>

      <form className="mc-next-btw-side-chat-compose" onSubmit={handleSubmit}>
        <textarea
          ref={inputRef}
          value={sideChat.draft}
          rows={2}
          placeholder="Ask off to the side"
          onChange={(event) => sideChat.onDraftChange(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button
          type="submit"
          className="mc-next-panel-button primary icon"
          aria-label="Send side chat message"
          disabled={sideChat.loading || !sideChat.draft.trim()}
        >
          <SendHorizontal size={15} />
        </button>
      </form>
    </aside>
  );
}

function BtwSideChatTurn({
  turn,
  streamingPreview,
}: {
  turn: ChatThreadTurnRecord;
  streamingPreview: ChatStreamingPreview | null;
}) {
  // A published (non-null) preview means the turn is still streaming or
  // settling its final reveal; the cleared preview is the idle signal.
  const isStreamingTurn = streamingPreview?.turnId === turn.turnId;
  const assistantContent = (isStreamingTurn ? streamingPreview?.visibleText : turn.assistantMessage?.content)?.trim();

  return (
    <article className="mc-next-btw-side-chat-turn">
      <div className="mc-next-btw-side-chat-message user">
        <span>User</span>
        <p>{turn.userMessage.content}</p>
      </div>
      {assistantContent ? (
        <div className="mc-next-btw-side-chat-message assistant">
          <span>Assistant</span>
          <p>{assistantContent}</p>
        </div>
      ) : null}
    </article>
  );
}

export function getBtwSideChatStorageKey(workspaceId: string): string {
  return `${STORAGE_KEY_PREFIX}${workspaceId || "default"}`;
}

export function readBtwSideChatPosition(workspaceId: string): BtwSideChatPanelPosition | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return null;
    }
    const raw = window.localStorage.getItem(getBtwSideChatStorageKey(workspaceId));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<BtwSideChatPanelPosition>;
    return normalizeBtwSideChatPosition(parsed);
  } catch {
    // Optional browser-local preference only.
    return null;
  }
}

export function writeBtwSideChatPosition(workspaceId: string, position: BtwSideChatPanelPosition): void {
  try {
    const normalized = normalizeBtwSideChatPosition(position);
    if (typeof window === "undefined" || !window.localStorage || !normalized) {
      return;
    }
    window.localStorage.setItem(getBtwSideChatStorageKey(workspaceId), JSON.stringify(normalized));
  } catch {
    // Optional browser-local preference only.
  }
}

export function removeBtwSideChatPosition(workspaceId: string): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }
    window.localStorage.removeItem(getBtwSideChatStorageKey(workspaceId));
  } catch {
    // Optional browser-local preference only.
  }
}

export function clampBtwSideChatPosition(
  position: BtwSideChatPanelPosition,
  viewport: BtwSideChatViewportSize,
  panel: BtwSideChatPanelSize,
): BtwSideChatPanelPosition {
  const safeViewport = {
    width: Math.max(viewport.width, VIEWPORT_PADDING * 2 + 1),
    height: Math.max(viewport.height, VIEWPORT_PADDING * 2 + 1),
  };
  const safePanel = {
    width: Math.max(1, Math.min(panel.width, safeViewport.width - VIEWPORT_PADDING * 2)),
    height: Math.max(1, Math.min(panel.height, safeViewport.height - VIEWPORT_PADDING * 2)),
  };
  const maxX = Math.max(VIEWPORT_PADDING, safeViewport.width - safePanel.width - VIEWPORT_PADDING);
  const maxY = Math.max(VIEWPORT_PADDING, safeViewport.height - safePanel.height - VIEWPORT_PADDING);
  return {
    x: clampNumber(position.x, VIEWPORT_PADDING, maxX),
    y: clampNumber(position.y, VIEWPORT_PADDING, maxY),
  };
}

export function getDefaultBtwSideChatPosition(
  viewport: BtwSideChatViewportSize,
  panel: BtwSideChatPanelSize,
): BtwSideChatPanelPosition {
  return clampBtwSideChatPosition(
    {
      x: viewport.width - panel.width - DESKTOP_RIGHT_OFFSET,
      y: viewport.height - panel.height - DESKTOP_BOTTOM_OFFSET,
    },
    viewport,
    panel,
  );
}

function getBtwSideChatViewportSize(): BtwSideChatViewportSize {
  return {
    width: window.innerWidth || document.documentElement.clientWidth || DEFAULT_PANEL_SIZE.width,
    height: window.innerHeight || document.documentElement.clientHeight || DEFAULT_PANEL_SIZE.height,
  };
}

function normalizeBtwSideChatPosition(value: Partial<BtwSideChatPanelPosition>): BtwSideChatPanelPosition | null {
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) {
    return null;
  }
  return {
    x: Number(value.x),
    y: Number(value.y),
  };
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isBtwSideChatInteractiveTarget(target: EventTarget): boolean {
  return target instanceof Element
    ? Boolean(target.closest("button, a, input, textarea, select, option, label, [role='button']"))
    : false;
}
