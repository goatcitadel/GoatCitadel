// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClassicChannelHostsCheck } from "./ClassicChannelHostsCheck";

const api = vi.hoisted(() => ({ fetchSettings: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);

const hosts = vi.hoisted(() => ({ ensureHostsAllowed: vi.fn() }));
vi.mock("../channel-hosts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../channel-hosts")>()),
  ensureHostsAllowed: hosts.ensureHostsAllowed,
}));

let root: Root;
let container: HTMLDivElement;

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  api.fetchSettings.mockReset();
  hosts.ensureHostsAllowed.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ClassicChannelHostsCheck", () => {
  it("checks the hosts without the Cockpit's query client, which Classic does not have", async () => {
    api.fetchSettings.mockResolvedValue({ revision: 1, networkAllowlist: ["api.line.me"] });

    await act(async () => root.render(<ClassicChannelHostsCheck hosts={["api.line.me"]} workspaceId="default" />));
    await settle();

    expect(container.textContent).toBe("GoatCitadel may reach api.line.me.");
  });

  it("passes on the addresses it can't read, with nothing to read for them", async () => {
    await act(async () =>
      root.render(
        <ClassicChannelHostsCheck
          hosts={[]}
          unreadable={[
            { label: "Webhook URL", kind: "saved" },
            { label: "Server", kind: "typed" },
          ]}
          workspaceId="default"
        />,
      ),
    );
    await settle();

    // js/missing-space-in-concatenation: the two notices are separate elements, so their
    // textContent joins with no separator. Keep the explicit join("") rather than `+`.
    expect(container.textContent).toBe(
      [
        "GoatCitadel can't read the address in Webhook URL after it's saved, so it can't check its host. Make sure GoatCitadel may reach it.",
        "GoatCitadel can't find a host in Server. Use an address like https://example.com.",
      ].join(""),
    );
    expect(api.fetchSettings).not.toHaveBeenCalled();
  });

  it("sends the operator to the Cockpit Inbox, since Classic has no Inbox page", async () => {
    api.fetchSettings.mockResolvedValue({ revision: 1, networkAllowlist: [] });
    hosts.ensureHostsAllowed.mockResolvedValue({ kind: "elsewhere", plan: { planId: "p-1" }, approvalId: "a-1" });
    await act(async () => root.render(<ClassicChannelHostsCheck hosts={["api.line.me"]} workspaceId="w-3" />));
    await settle();

    const allow = [...container.querySelectorAll("button")].find((item) => item.textContent === "Allow these hosts");
    await act(async () => allow!.click());
    await settle();

    const approve = [...container.querySelectorAll("a")].find((item) => item.textContent === "Approve it in Inbox");
    expect(approve).toBeDefined();
    const target = new URL(approve!.getAttribute("href")!, "http://classic.invalid");
    expect(target.pathname).toBe("/inbox");
    expect(target.searchParams.get("shell")).toBe("cockpit");
    expect(target.searchParams.get("approvalId")).toBe("a-1");
    expect(target.searchParams.get("workspaceId")).toBe("w-3");
    expect(container.querySelectorAll('[role="status"], [role="alert"], [aria-live]')).toHaveLength(0);
  });
});
