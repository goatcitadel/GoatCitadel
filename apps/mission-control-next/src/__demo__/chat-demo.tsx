import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AssistantMessageRenderer } from "@goatcitadel/mission-control-shared/components/chat/AssistantMessageRenderer";
import { ChatStreamStatusBar } from "@goatcitadel/mission-control-shared/components/chat/ChatStreamStatusBar";
import { isInteractiveChatEventTarget } from "@goatcitadel/mission-control-shared/components/chat/ChatThreadPrimitives";

import "@next/styles/mission-control-next-tokens.css";
import "@next/styles/mission-control-next-foundation.css";
import "@next/styles/mission-control-next.css";
import "@next/features/native-routes/primitives/primitives.css";
import "@next/features/threaded-surface/styles/timeline.css";
import "@next/features/threaded-surface/styles/code-highlight.css";
import "@next/features/threaded-surface/styles/composer.css";
import "./chat-demo.css";
import sampleImageUrl from "./assets/sample-image.png";
import sampleAudioUrl from "./assets/sample-audio.mp3";
import sampleVideoUrl from "./assets/sample-video.mp4";

type Theme = "theme-signal-noir" | "theme-citadel-light";

interface DemoTurn {
  id: string;
  role: "user" | "assistant";
  actor: string;
  timestamp: string;
  content: string;
  streaming?: boolean;
  groupedWithPrevious?: boolean;
  attachments?: DemoAttachment[];
  citations?: DemoCitation[];
  selected?: boolean;
}

interface DemoAttachment {
  id: string;
  kind: "image" | "audio" | "video";
  src: string;
  fileName: string;
  mimeType: string;
  sizeKb: number;
}

interface DemoCitation {
  id: string;
  title: string;
  url: string;
  snippet: string;
}

const SAMPLE_PROSE = `Here's a quick overview of what changed.

The streaming reveal now only animates **newly arrived** characters, so you no longer see the whole tail re-flicker on every delta. The cursor pulses with a soft halo instead of blinking, and the token fade carries a tiny rise.

Below is the helper that drives the diff:

\`\`\`ts
function diffStreamingText(prev: string, next: string): { stable: string; tail: string } {
  if (next.startsWith(prev)) {
    return { stable: prev, tail: next.slice(prev.length) };
  }
  return { stable: "", tail: next };
}
\`\`\`

Tables, blockquotes, and citations got a polish too:

| Surface     | Before        | After                   |
| ----------- | ------------- | ----------------------- |
| Code blocks | floating tag  | top header + copy       |
| Tables      | plain         | zebra + sticky header   |
| Citations   | article rows  | numbered pill chips     |

> Animations honor \`prefers-reduced-motion\` — cursor stops, token fades become instant.`;

const DEMO_ATTACHMENTS: DemoAttachment[] = [
  {
    id: "img-1",
    kind: "image",
    src: sampleImageUrl,
    fileName: "release-mockup.png",
    mimeType: "image/png",
    sizeKb: 14,
  },
  {
    id: "aud-1",
    kind: "audio",
    src: sampleAudioUrl,
    fileName: "stand-up-notes.mp3",
    mimeType: "audio/mpeg",
    sizeKb: 24,
  },
  {
    id: "vid-1",
    kind: "video",
    src: sampleVideoUrl,
    fileName: "ux-walkthrough.mp4",
    mimeType: "video/mp4",
    sizeKb: 262,
  },
];

const DEMO_CITATIONS: DemoCitation[] = [
  {
    id: "c1",
    title: "Streaming UX patterns — Chat surfaces v3",
    url: "https://example.test/streaming-patterns",
    snippet: "Smooth token reveals reduce perceived latency.",
  },
  {
    id: "c2",
    title: "OKLCH color guidance",
    url: "https://example.test/oklch",
    snippet: "Perceptual uniformity across themes.",
  },
  {
    id: "c3",
    title: "Auto-scroll and overflow-anchor",
    url: "https://example.test/overflow-anchor",
    snippet: "Let the browser pin scroll, not JS.",
  },
];

function buildInitialTurns(): DemoTurn[] {
  return [
    {
      id: "t-1",
      role: "user",
      actor: "you",
      timestamp: minutesAgo(7),
      content: "Can you give me a quick summary of what we changed?",
    },
    {
      id: "t-2",
      role: "assistant",
      actor: "assistant",
      timestamp: minutesAgo(7),
      content:
        "Sure — this branch tightens streaming reveals, adds inline image / audio / video previews, and refreshes message identity.",
    },
    {
      id: "t-3",
      role: "user",
      actor: "you",
      timestamp: minutesAgo(6),
      content: "Also, here's the asset bundle from design:",
      attachments: DEMO_ATTACHMENTS,
    },
    {
      id: "t-4",
      role: "user",
      actor: "you",
      timestamp: minutesAgo(6),
      content: "And one more clarification before we go on.",
      groupedWithPrevious: true,
    },
    {
      id: "t-5",
      role: "assistant",
      actor: "assistant",
      timestamp: minutesAgo(5),
      content:
        "Got the files. Inline previews now render directly in the bubble — image opens a lightbox, audio gets a control with the area accent, video plays inline.",
      citations: DEMO_CITATIONS,
    },
  ];
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function formatActorTimestamp(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function DemoChannelStatus({ phase }: { phase: "idle" | "streaming" | "completed" }) {
  if (phase === "idle") return null;
  return (
    <span className={`mc-next-thread-channel-activity phase-${phase}`}>
      <span aria-hidden="true">●</span>
      <span>{phase === "streaming" ? "Streaming" : "Just now"}</span>
    </span>
  );
}

function DemoCitationChips({ citations }: { citations: DemoCitation[] }) {
  if (!citations.length) return null;
  return (
    <div className="mc-next-thread-citations" aria-label="Citations for this answer">
      {citations.map((citation, index) => (
        <article key={citation.id}>
          <div>
            <strong>{index + 1}</strong>
            <a href={citation.url} target="_blank" rel="noreferrer">
              {citation.title}
            </a>
          </div>
          <p>knowledge · {citation.snippet}</p>
        </article>
      ))}
    </div>
  );
}

function InlineMediaCard({
  attachment,
  onOpenLightbox,
}: {
  attachment: DemoAttachment;
  onOpenLightbox: (attachment: DemoAttachment) => void;
}) {
  return (
    <article className="mc-next-attachment-preview-card">
      <div className="mc-next-attachment-preview-head">
        <strong>{attachment.fileName}</strong>
        <span>{attachment.mimeType}</span>
      </div>
      <p className="mc-next-attachment-preview-meta">{attachment.sizeKb} KB · ready</p>
      <div className="mc-next-attachment-inline-media">
        {attachment.kind === "image" ? (
          <button
            type="button"
            className="mc-next-attachment-image-trigger"
            aria-label={`Open ${attachment.fileName} in full view`}
            onClick={() => onOpenLightbox(attachment)}
          >
            <img
              src={attachment.src}
              alt={attachment.fileName}
              className="mc-next-attachment-inline-image"
              loading="lazy"
              decoding="async"
              data-demo={`image:${attachment.id}`}
            />
          </button>
        ) : attachment.kind === "audio" ? (
          <audio
            className="mc-next-attachment-inline-audio"
            controls
            preload="metadata"
            src={attachment.src}
            data-demo={`audio:${attachment.id}`}
          />
        ) : (
          <video
            className="mc-next-attachment-inline-video"
            controls
            preload="metadata"
            src={attachment.src}
            data-demo={`video:${attachment.id}`}
          />
        )}
      </div>
      <div className="mc-next-attachment-preview-actions">
        <button type="button" className="mc-next-attachment-preview-action">
          Open
        </button>
        <button type="button" className="mc-next-attachment-preview-action">
          Download
        </button>
      </div>
    </article>
  );
}

function Lightbox({ attachment, onClose }: { attachment: DemoAttachment | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !attachment) return;
    if (!dialog.open && typeof dialog.showModal === "function") {
      dialog.showModal();
    }
    const handleCancel = (event: Event) => {
      event.preventDefault();
      onClose();
    };
    dialog.addEventListener("cancel", handleCancel);
    return () => {
      dialog.removeEventListener("cancel", handleCancel);
      if (dialog.open && typeof dialog.close === "function") dialog.close();
    };
  }, [attachment, onClose]);
  if (!attachment) return null;
  return (
    <dialog
      ref={ref}
      className="mc-next-attachment-lightbox"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <button type="button" className="mc-next-attachment-lightbox-close" aria-label="Close preview" onClick={onClose}>
        ×
      </button>
      <img src={attachment.src} alt={attachment.fileName} />
    </dialog>
  );
}

function DemoTurnCard({
  turn,
  onSelect,
  onOpenLightbox,
}: {
  turn: DemoTurn;
  onSelect: (id: string) => void;
  onOpenLightbox: (attachment: DemoAttachment) => void;
}) {
  const classes = [
    "mc-next-thread-turn",
    turn.selected ? "selected" : "",
    turn.streaming ? "streaming" : "",
    turn.groupedWithPrevious ? "grouped" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <article className={classes} data-turn-id={turn.id}>
      <div
        className="mc-next-thread-turn-surface"
        onClick={(event) => {
          if (!isInteractiveChatEventTarget(event.target, event.currentTarget)) {
            onSelect(turn.id);
          }
        }}
      >
        <button
          type="button"
          className="mc-next-thread-open-turn"
          aria-label={`Open turn: ${turn.content.trim().slice(0, 60) || "turn"}`}
          aria-pressed={turn.selected}
          onClick={() => onSelect(turn.id)}
        >
          Open turn
        </button>
        {turn.role === "user" ? (
          <div className="mc-next-thread-bubble user">
            <p className="mc-next-thread-meta">
              <strong>You</strong> · <time>{formatActorTimestamp(turn.timestamp)}</time>
              <DemoChannelStatus phase={turn.streaming ? "streaming" : "idle"} />
            </p>
            <AssistantMessageRenderer role="user" content={turn.content} />
            {turn.attachments && turn.attachments.length > 0 ? (
              <div className="mc-next-attachment-preview-stack">
                {turn.attachments.map((attachment) => (
                  <InlineMediaCard key={attachment.id} attachment={attachment} onOpenLightbox={onOpenLightbox} />
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <div className={`mc-next-thread-bubble assistant${turn.streaming ? " streaming" : ""}`}>
            <p className="mc-next-thread-meta">
              <strong>GoatCitadel</strong> · <time>{formatActorTimestamp(turn.timestamp)}</time>
            </p>
            <AssistantMessageRenderer
              role="assistant"
              content={turn.content}
              running={turn.streaming}
              streamPresentationMode="smooth"
            />
            {turn.citations && turn.citations.length > 0 ? <DemoCitationChips citations={turn.citations} /> : null}
          </div>
        )}
      </div>
      <div className="mc-next-thread-strip">
        <span className="mc-next-status-chip" data-tone={turn.streaming ? "info" : "success"} data-size="sm">
          <span className="mc-next-status-chip-label">{turn.streaming ? "running" : "completed"}</span>
        </span>
        <span>{turn.streaming ? "using" : "used"} claude-sonnet-4-6</span>
        {turn.citations && turn.citations.length > 0 ? <span>{turn.citations.length} citations</span> : null}
        <button type="button" className="mc-next-thread-inline-button">
          Details
        </button>
      </div>
    </article>
  );
}

function ChatDemo() {
  const [theme, setTheme] = useState<Theme>("theme-signal-noir");
  const [turns, setTurns] = useState<DemoTurn[]>(buildInitialTurns);
  const [streamStatus, setStreamStatus] = useState<"idle" | "streaming" | "connecting">("idle");
  const [lightbox, setLightbox] = useState<DemoAttachment | null>(null);
  const [showJumpButton, setShowJumpButton] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const streamingTickerRef = useRef<number | null>(null);

  const handleSelectTurn = (id: string) => {
    setTurns((prev) => prev.map((turn) => ({ ...turn, selected: turn.id === id })));
  };

  const startStream = () => {
    const newTurnId = `stream-${Date.now()}`;
    setStreamStatus("streaming");
    setTurns((prev) => [
      ...prev.filter((t) => !t.id.startsWith("stream-") && !t.id.startsWith("user-stream-")),
      {
        id: `user-${newTurnId}`,
        role: "user",
        actor: "you",
        timestamp: new Date().toISOString(),
        content: "Walk me through the streaming + code-block polish.",
      },
      {
        id: newTurnId,
        role: "assistant",
        actor: "assistant",
        timestamp: new Date().toISOString(),
        content: "",
        streaming: true,
      },
    ]);

    let cursor = 0;
    const tick = () => {
      cursor = Math.min(SAMPLE_PROSE.length, cursor + 4);
      setTurns((prev) =>
        prev.map((turn) => (turn.id === newTurnId ? { ...turn, content: SAMPLE_PROSE.slice(0, cursor) } : turn)),
      );
      if (cursor < SAMPLE_PROSE.length) {
        streamingTickerRef.current = window.setTimeout(tick, 28);
      } else {
        setStreamStatus("idle");
        setTurns((prev) => prev.map((turn) => (turn.id === newTurnId ? { ...turn, streaming: false } : turn)));
      }
    };
    streamingTickerRef.current = window.setTimeout(tick, 100);
  };

  const stopStream = () => {
    if (streamingTickerRef.current !== null) {
      clearTimeout(streamingTickerRef.current);
      streamingTickerRef.current = null;
    }
    setStreamStatus("idle");
    setTurns((prev) => prev.map((turn) => (turn.streaming ? { ...turn, streaming: false } : turn)));
  };

  const toggleTheme = () => {
    setTheme((prev) => (prev === "theme-signal-noir" ? "theme-citadel-light" : "theme-signal-noir"));
  };

  const openLightboxForFirstImage = () => {
    const firstImage = DEMO_ATTACHMENTS.find((a) => a.kind === "image");
    if (firstImage) setLightbox(firstImage);
  };

  const scrollToTop = () => {
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };

  const scrollToBottom = () => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 60;
      setShowJumpButton(!nearBottom);
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    // Expose driver API for the Playwright recorder.
    (window as unknown as { __demo: unknown }).__demo = {
      startStream,
      stopStream,
      toggleTheme,
      openLightbox: openLightboxForFirstImage,
      closeLightbox: () => setLightbox(null),
      selectTurn: handleSelectTurn,
      scrollToTop,
      scrollToBottom,
      jumpToBottom: () => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "auto" });
      },
      reset: () => {
        stopStream();
        setTurns(buildInitialTurns());
        setStreamStatus("idle");
        setLightbox(null);
      },
      setTheme: (next: Theme) => setTheme(next),
      getTheme: () => theme,
    };
    return () => {
      delete (window as unknown as { __demo?: unknown }).__demo;
    };
  });

  return (
    <div className={`mc-next-shell ${theme} demo-shell`}>
      <header className="demo-header">
        <span className="demo-header-title">Chat display polish — live preview</span>
        <div className="demo-header-actions">
          <span className="demo-header-theme">{theme.replace("theme-", "")}</span>
          <button
            type="button"
            className="mc-next-thread-inline-button"
            onClick={streamStatus === "idle" ? startStream : stopStream}
          >
            {streamStatus === "idle" ? "Start streaming" : "Stop streaming"}
          </button>
        </div>
      </header>
      <div className="demo-stage">
        <div className="demo-card">
          <div ref={scrollRef} className="mc-next-thread-scroll" data-thread-hydrated="true">
            <div className="mc-next-thread-view">
              <div className="mc-next-thread-list">
                {turns.map((turn) => (
                  <DemoTurnCard key={turn.id} turn={turn} onSelect={handleSelectTurn} onOpenLightbox={setLightbox} />
                ))}
                <ChatStreamStatusBar mode="chat" status={streamStatus} queuedCount={0} error={null} />
              </div>
            </div>
            {showJumpButton ? (
              <button type="button" className="mc-next-thread-jump-latest" onClick={scrollToBottom}>
                Jump to latest
              </button>
            ) : null}
          </div>
        </div>
      </div>
      <Lightbox attachment={lightbox} onClose={() => setLightbox(null)} />
    </div>
  );
}

const container = document.getElementById("demo-root");
if (container) {
  createRoot(container).render(<ChatDemo />);
}
