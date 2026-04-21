import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ReflexContainer, ReflexElement, ReflexSplitter } from "react-reflex";

export interface ResizablePaneDescriptor {
  id: string;
  children: ReactNode;
  defaultSize?: number;
  minSize?: number;
  maxSize?: number;
  className?: string;
  contentClassName?: string;
}

interface ResizablePaneLayoutProps {
  panes: ResizablePaneDescriptor[];
  orientation?: "horizontal" | "vertical";
  storageKey?: string;
  className?: string;
  splitterClassName?: string;
}

const STORAGE_PREFIX = "goatcitadel.layout.";

function resolveStorageKey(storageKey?: string): string | null {
  const trimmed = storageKey?.trim();
  if (!trimmed) {
    return null;
  }
  return `${STORAGE_PREFIX}${trimmed}`;
}

function readStoredPaneSizes(storageKey?: string): Record<string, number> {
  if (typeof window === "undefined") {
    return {};
  }
  const resolvedKey = resolveStorageKey(storageKey);
  if (!resolvedKey) {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(resolvedKey);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([paneId, size]) =>
        typeof size === "number" && Number.isFinite(size) && size > 0 ? [[paneId, Math.round(size)]] : [],
      ),
    );
  } catch {
    return {};
  }
}

function joinClassNames(...values: Array<string | undefined | null | false>): string {
  return values.filter(Boolean).join(" ");
}

export function ResizablePaneLayout({
  panes,
  orientation = "vertical",
  storageKey,
  className,
  splitterClassName,
}: ResizablePaneLayoutProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [storedSizes, setStoredSizes] = useState<Record<string, number>>(() => readStoredPaneSizes(storageKey));
  const shouldRenderReflex = typeof window !== "undefined" && import.meta.env.MODE !== "test";

  useEffect(() => {
    setStoredSizes(readStoredPaneSizes(storageKey));
  }, [storageKey]);

  const persistPaneSizes = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }
    const resolvedKey = resolveStorageKey(storageKey);
    const container = rootRef.current?.querySelector(":scope > .reflex-container");
    if (!container) {
      return;
    }
    const paneElements = Array.from(container.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement && child.classList.contains("gc-resizable-pane"),
    );
    const nextSizes = Object.fromEntries(
      panes.flatMap((pane, index) => {
        const element = paneElements[index];
        const measuredSize = element
          ? Math.round(
              orientation === "vertical"
                ? element.getBoundingClientRect().width
                : element.getBoundingClientRect().height,
            )
          : undefined;
        const size = measuredSize && measuredSize > 0 ? measuredSize : (storedSizes[pane.id] ?? pane.defaultSize);
        return typeof size === "number" && size > 0 ? [[pane.id, size]] : [];
      }),
    );
    setStoredSizes(nextSizes);
    if (resolvedKey) {
      window.localStorage.setItem(resolvedKey, JSON.stringify(nextSizes));
    }
  }, [orientation, panes, storageKey, storedSizes]);

  if (panes.length === 0) {
    return null;
  }

  if (panes.length === 1) {
    const [pane] = panes;
    if (!pane) {
      return null;
    }
    return (
      <div ref={rootRef} className={joinClassNames("gc-resizable-layout gc-resizable-layout-single", className)}>
        <div className={joinClassNames("gc-resizable-pane-content", pane.contentClassName)}>{pane.children}</div>
      </div>
    );
  }

  if (!shouldRenderReflex) {
    return (
      <div
        ref={rootRef}
        className={joinClassNames("gc-resizable-layout gc-resizable-layout-fallback", className)}
        data-orientation={orientation}
      >
        {panes.map((pane) => (
          <div key={pane.id} className={joinClassNames("gc-resizable-pane-content", pane.contentClassName)}>
            {pane.children}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div ref={rootRef} className={joinClassNames("gc-resizable-layout", className)}>
      <ReflexContainer
        orientation={orientation}
        className={joinClassNames("gc-resizable-layout-container", `gc-resizable-layout-${orientation}`)}
        windowResizeAware
      >
        {panes.map((pane, index) => (
          <Fragment key={pane.id}>
            <ReflexElement
              className={joinClassNames("gc-resizable-pane", pane.className)}
              size={storedSizes[pane.id] ?? pane.defaultSize}
              minSize={pane.minSize}
              maxSize={pane.maxSize}
              onStopResize={persistPaneSizes}
            >
              <div className={joinClassNames("gc-resizable-pane-content", pane.contentClassName)}>{pane.children}</div>
            </ReflexElement>
            {index < panes.length - 1 ? (
              <ReflexSplitter
                className={joinClassNames("gc-resizable-splitter", splitterClassName)}
                onStopResize={persistPaneSizes}
              />
            ) : null}
          </Fragment>
        ))}
      </ReflexContainer>
    </div>
  );
}
