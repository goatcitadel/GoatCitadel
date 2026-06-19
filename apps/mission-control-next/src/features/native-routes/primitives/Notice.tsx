import type { ReactNode } from "react";
import { ErrorState } from "./ErrorState";

export type NoticeTone = "error" | "warning" | "success" | "info";

export type NoticeBannerProps = {
  tone: NoticeTone;
  message: ReactNode;
  /** Mirrors ErrorState sizing for the danger/caution tones. */
  size?: "inline" | "default";
};

/**
 * The single notice surface shared by routes, settings, and the library. It maps
 * the four-tone notice model onto the consolidated a11y surfaces:
 *  - `error`   -> ErrorState tone="danger"  (role="alert")
 *  - `warning` -> ErrorState tone="caution" (role="alert")
 *  - `success`/`info` -> a polite runtime-notice banner (role="status")
 *
 * Named `NoticeBanner` (not `Notice`) to avoid colliding with the `Notice` data
 * type consumed by settings/library helpers.
 */
export function NoticeBanner({ tone, message, size = "inline" }: NoticeBannerProps) {
  if (tone === "error") {
    return <ErrorState size={size} tone="danger" description={message} />;
  }
  if (tone === "warning") {
    return <ErrorState size={size} tone="caution" description={message} />;
  }
  return (
    <div className={`mc-next-runtime-notice tone-${tone}`} role="status">
      <span>{message}</span>
    </div>
  );
}
