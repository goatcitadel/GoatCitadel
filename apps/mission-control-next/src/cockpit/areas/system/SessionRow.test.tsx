// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionMeta } from "@goatcitadel/contracts";
import { SessionRow } from "./SessionRow";

const preferences = vi.hoisted(() => ({ showTechnicalDetails: false }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => preferences }));
vi.mock("./SystemOwnerLink", () => ({
  SystemOwnerLink: ({ href, children }: { href: string; children: string }) => <a href={href}>{children}</a>,
}));

const item = {
  sessionId: "session-0123",
  channel: "web",
  kind: "dm",
  account: "operator",
  displayName: "Owner conversation",
  lastActivityAt: "2026-10-13T00:00:00Z",
  health: "degraded",
  budgetState: "ok",
  tokenInput: 10,
  tokenOutput: 5,
  tokenTotal: 15,
} as SessionMeta;
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  preferences.showTechnicalDetails = false;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const render = (onDetails?: (id: string) => void) =>
  act(() =>
    root.render(
      <ul>
        <SessionRow item={item} onDetails={onDetails} />
      </ul>,
    ),
  );

it("shows the title, health and channel without the session id", () => {
  render();
  expect(host.querySelector("h3")?.textContent).toBe("Owner conversation");
  expect(host.textContent).toContain("Degraded");
  expect(host.textContent).toContain("Web chat · Direct message");
  expect(host.textContent).not.toContain("session-0123");
  expect(host.querySelector("a")?.getAttribute("href")).toBe("/chat?sessionId=session-0123");
});

it("keeps the session id in technical details", () => {
  preferences.showTechnicalDetails = true;
  render();
  expect(host.textContent).toContain("session-0123");
});

it("renders a partial session record without token counts", () => {
  act(() =>
    root.render(
      <ul>
        <SessionRow item={{ sessionId: "partial", channel: "web", lastActivityAt: "bad" } as SessionMeta} />
      </ul>,
    ),
  );
  expect(host.querySelector("h3")?.textContent).toBe("Web chat conversation");
  expect(host.textContent).toContain("Usage: Not reported");
  expect(host.textContent).toContain("Last activity Not reported");
  expect(host.textContent).toContain("Health unknown");
});

it("offers Details only when the page can open a session", () => {
  render();
  expect(host.querySelector("button")).toBeNull();
  const onDetails = vi.fn();
  render(onDetails);
  const details = host.querySelector<HTMLButtonElement>('[aria-label="Details: Owner conversation"]')!;
  expect(details.textContent).toBe("Details");
  act(() => details.click());
  expect(onDetails).toHaveBeenCalledExactlyOnceWith("session-0123");
});
