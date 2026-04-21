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
const STORAGE_VERSION = 3;

interface StoredPaneLayout {
  version: number;
  panes: Record<string, number>;
}

function resolveStorageKey(storageKey?: string): string | null {
  const trimmed = storageKey?.trim();
  if (!trimmed) {
    return null;
  }
  return `${STORAGE_PREFIX}${trimmed}`;
}

function clearStoredPaneLayout(storageKey?: string) {
  if (typeof window === "undefined") {
    return;
  }
  const resolvedKey = resolveStorageKey(storageKey);
  if (!resolvedKey) {
    return;
  }
  window.localStorage.removeItem(resolvedKey);
}

function readStoredPaneFlexes(storageKey?: string): Record<string, number> {
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
    const parsed = JSON.parse(raw) as StoredPaneLayout;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.version !== STORAGE_VERSION ||
      !parsed.panes ||
      typeof parsed.panes !== "object"
    ) {
      clearStoredPaneLayout(storageKey);
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed.panes).flatMap(([paneId, size]) =>
        typeof size === "number" && Number.isFinite(size) && size > 0 ? [[paneId, size]] : [],
      ),
    );
  } catch {
    return {};
  }
}

function measurePaneFlexes(
  container: Element | null,
  panes: readonly ResizablePaneDescriptor[],
  orientation: "horizontal" | "vertical",
): Record<string, number> {
  if (!container) {
    return {};
  }
  const paneElements = Array.from(container.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement && child.classList.contains("gc-resizable-pane"),
  );
  const measuredSizes = panes.map((_, index) => {
    const element = paneElements[index];
    if (!element) {
      return 0;
    }
    const rect = element.getBoundingClientRect();
    return orientation === "vertical" ? rect.width : rect.height;
  });
  const totalMeasuredSize = measuredSizes.reduce((sum, size) => sum + size, 0);
  if (!(totalMeasuredSize > 0)) {
    return {};
  }
  return Object.fromEntries(
    panes.flatMap((pane, index) => {
      const measuredSize = measuredSizes[index] ?? 0;
      if (!(measuredSize > 0)) {
        return [];
      }
      return [[pane.id, measuredSize / totalMeasuredSize]];
    }),
  );
}

function resolveDefaultPaneFlexes(panes: readonly ResizablePaneDescriptor[]): Record<string, number> {
  const weightedSizes = panes.map((pane) => pane.defaultSize ?? pane.minSize ?? 1);
  const totalWeight = weightedSizes.reduce((sum, size) => sum + size, 0);
  if (!(totalWeight > 0)) {
    return {};
  }
  return Object.fromEntries(
    panes.map((pane, index) => {
      const weight = weightedSizes[index] ?? 1;
      return [pane.id, weight / totalWeight];
    }),
  );
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
  const [storedFlexes, setStoredFlexes] = useState<Record<string, number>>(() => readStoredPaneFlexes(storageKey));
  const shouldRenderReflex = typeof window !== "undefined" && import.meta.env.MODE !== "test";
  const defaultFlexes = resolveDefaultPaneFlexes(panes);

  useEffect(() => {
    setStoredFlexes(readStoredPaneFlexes(storageKey));
  }, [storageKey]);

  const persistPaneLayout = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }
    const resolvedKey = resolveStorageKey(storageKey);
    const container = rootRef.current?.querySelector(":scope > .reflex-container") ?? null;
    const nextFlexes = measurePaneFlexes(container, panes, orientation);
    if (Object.keys(nextFlexes).length === 0) {
      return;
    }
    setStoredFlexes(nextFlexes);
    if (resolvedKey) {
      window.localStorage.setItem(
        resolvedKey,
        JSON.stringify({
          version: STORAGE_VERSION,
          panes: nextFlexes,
        } satisfies StoredPaneLayout),
      );
    }
  }, [orientation, panes, storageKey]);

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
              flex={storedFlexes[pane.id] ?? defaultFlexes[pane.id]}
              minSize={pane.minSize}
              maxSize={pane.maxSize}
              onStopResize={persistPaneLayout}
            >
              <div className={joinClassNames("gc-resizable-pane-content", pane.contentClassName)}>{pane.children}</div>
            </ReflexElement>
            {index < panes.length - 1 ? (
              <ReflexSplitter
                className={joinClassNames("gc-resizable-splitter", splitterClassName)}
                onStopResize={persistPaneLayout}
              />
            ) : null}
          </Fragment>
        ))}
      </ReflexContainer>
    </div>
  );
}
