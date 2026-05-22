import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";

export interface UseAutoGrowTextareaOptions {
  minLines?: number;
  maxLines?: number;
}

const DEFAULT_MIN_LINES = 5;
const DEFAULT_MAX_LINES = 14;
const FALLBACK_LINE_HEIGHT_PX = 20;

function resolveLineHeightPx(element: HTMLTextAreaElement): number {
  const computed = window.getComputedStyle(element);
  const parsed = Number.parseFloat(computed.lineHeight);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  const fontSize = Number.parseFloat(computed.fontSize);
  if (Number.isFinite(fontSize) && fontSize > 0) {
    return fontSize * 1.4;
  }
  return FALLBACK_LINE_HEIGHT_PX;
}

function resolveVerticalChromePx(element: HTMLTextAreaElement): number {
  const computed = window.getComputedStyle(element);
  const top = Number.parseFloat(computed.paddingTop) || 0;
  const bottom = Number.parseFloat(computed.paddingBottom) || 0;
  const borderTop = Number.parseFloat(computed.borderTopWidth) || 0;
  const borderBottom = Number.parseFloat(computed.borderBottomWidth) || 0;
  return top + bottom + borderTop + borderBottom;
}

/**
 * Grows a textarea between [minLines, maxLines] of its current line-height as
 * the operator types. Internal scroll engages past `maxLines`. Honors the
 * caller's existing CSS for borders, padding, and resize behavior - this hook
 * only mutates `element.style.height`.
 *
 * Returns a `recalculate` callback the caller can fire after non-input changes
 * (programmatic value sets, layout-altering CSS class toggles, etc.).
 */
export function useAutoGrowTextarea(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  options: UseAutoGrowTextareaOptions = {},
): () => void {
  const minLines = options.minLines ?? DEFAULT_MIN_LINES;
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const lastDimensionsRef = useRef<{ lineHeight: number; chrome: number } | null>(null);

  const recalculate = useCallback(() => {
    const element = ref.current;
    if (!element || typeof window === "undefined") {
      return;
    }
    const lineHeight = resolveLineHeightPx(element);
    const chrome = resolveVerticalChromePx(element);
    lastDimensionsRef.current = { lineHeight, chrome };

    const minHeight = Math.round(minLines * lineHeight + chrome);
    const maxHeight = Math.round(maxLines * lineHeight + chrome);

    // Collapse to "auto" so scrollHeight reflects the natural content height
    // rather than the previous explicit height.
    element.style.height = "auto";
    const contentHeight = element.scrollHeight;
    const nextHeight = Math.max(minHeight, Math.min(contentHeight, maxHeight));
    element.style.height = `${nextHeight}px`;
    element.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
  }, [ref, minLines, maxLines]);

  useLayoutEffect(() => {
    recalculate();
  }, [recalculate, value]);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof window === "undefined" || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => recalculate());
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [ref, recalculate]);

  return recalculate;
}
