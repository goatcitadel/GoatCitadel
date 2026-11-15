// @vitest-environment happy-dom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatTurnFailureCard } from "./ChatTurnFailureCard";

vi.mock("../../data/use-model-label", () => ({
  useProviderLabelLookup: () => (id?: string) => (id === "ut11-local-unreachable" ? "Local test runtime" : undefined),
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const render = (element: ReactElement) => act(async () => root.render(element));

describe("ChatTurnFailureCard provider reach failures", () => {
  it("names the provider that dropped the connection and links to model providers", async () => {
    await render(
      <ChatTurnFailureCard
        failed
        answered={false}
        failureClass="network_interrupted"
        providerId="ut11-local-unreachable"
        hint="Check the gateway or network connection, then retry the turn."
      />,
    );
    expect(container.textContent).toContain("Couldn't reach Local test runtime");
    expect(container.textContent).toContain(
      "The connection to Local test runtime dropped before it answered. Check the gateway or network connection, then retry the turn.",
    );
    expect(container.querySelector('a[href^="/settings/models"][href$="#providers"]')?.textContent).toBe(
      "Open model providers",
    );
  });

  it("takes the recovery from the hint for a turn that cannot be resent", async () => {
    await render(
      <ChatTurnFailureCard
        failed
        answered={false}
        failureClass="network_interrupted"
        providerId="ut11-local-unreachable"
        hint="Use Run details under More, below this message."
      />,
    );
    expect(container.textContent).toContain(
      "The connection to Local test runtime dropped before it answered. Use Run details under More, below this message.",
    );
    expect(container.textContent).not.toContain("retry");
  });

  it("keeps the generic card when the turn recorded no provider", async () => {
    await render(
      <ChatTurnFailureCard
        failed
        answered={false}
        failureClass="network_interrupted"
        hint="Check the gateway or network connection, then retry the turn."
      />,
    );
    expect(container.textContent).toContain("The connection dropped");
    expect(container.querySelector('a[href^="/settings/models"][href$="#providers"]')).toBeNull();
  });

  it("keeps the body lowercase mid-sentence when the provider has no label", async () => {
    await render(
      <ChatTurnFailureCard
        failed
        answered={false}
        failureClass="network_interrupted"
        providerId="other"
        hint="Check the gateway or network connection, then retry the turn."
      />,
    );
    expect(container.textContent).toContain("Couldn't reach the model provider");
    expect(container.textContent).toContain(
      "The connection to the model provider dropped before it answered. Check the gateway or network connection, then retry the turn.",
    );
  });

  it("says a named slow provider did not answer in time", async () => {
    await render(
      <ChatTurnFailureCard
        failed
        answered={false}
        failureClass="provider_timeout"
        providerId="ut11-local-unreachable"
        hint="Wait a moment, then retry"
      />,
    );
    expect(container.textContent).toContain("Local test runtime took too long to answer");
    expect(container.textContent).toContain("Local test runtime did not answer in time. Wait a moment, then retry");
  });

  it("says a slow provider took too long, by name", async () => {
    await render(
      <ChatTurnFailureCard
        failed
        answered={false}
        failureClass="provider_timeout"
        providerId="other"
        hint="Wait a moment, then retry"
      />,
    );
    expect(container.textContent).toContain("The model provider took too long to answer");
    expect(container.textContent).toContain("The model provider did not answer in time. Wait a moment, then retry");
  });
});

describe("ChatTurnFailureCard blocked tools", () => {
  it("links a blocked tool to the tool rules", async () => {
    await render(
      <ChatTurnFailureCard failed answered={false} failureClass="tool_blocked" hint="Change the rule, then retry." />,
    );
    const link = Array.from(container.querySelectorAll("a")).find((a) => a.textContent === "Open tool rules");
    expect(link?.getAttribute("href")).toMatch(/^\/settings\/safety/u);
    expect(link?.getAttribute("href")).toContain("permission-profile");
  });

  it("offers no tool rules link for another failure", async () => {
    await render(<ChatTurnFailureCard failed answered={false} failureClass="tool_failed" hint="Retry." />);
    expect(container.textContent).not.toContain("Open tool rules");
  });
});
