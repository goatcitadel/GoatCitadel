// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOSTS_UNKNOWN } from "../channel-hosts";
import { ChannelHostsCheck } from "./ChannelHostsCheck";

const api = vi.hoisted(() => ({ fetchSettings: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);

const hosts = vi.hoisted(() => ({ ensureHostsAllowed: vi.fn() }));
vi.mock("../channel-hosts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../channel-hosts")>()),
  ensureHostsAllowed: hosts.ensureHostsAllowed,
}));

const LINE = ["api.line.me"];
const settings = (networkAllowlist: string[]) => ({ revision: 3, networkAllowlist });

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

/** Lets the allowlist read, and the render that follows it, finish: the query client tells the page on a timer. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function show(props: { hosts: readonly string[]; unreadable?: readonly string[]; workspaceId?: string }) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ChannelHostsCheck
          hosts={props.hosts}
          {...(props.unreadable ? { unreadable: props.unreadable } : {})}
          workspaceId={props.workspaceId ?? "default"}
        />
      </QueryClientProvider>,
    );
  });
  await settle();
}

const buttons = () => [...container.querySelectorAll<HTMLButtonElement>("button")];
const button = (label: string) => buttons().find((candidate) => candidate.textContent?.trim() === label);
const link = (label: string) =>
  [...container.querySelectorAll<HTMLAnchorElement>("a")].find((candidate) => candidate.textContent?.trim() === label);
const text = () => container.textContent?.replace(/\s+/gu, " ").trim() ?? "";
async function click(element: Element | undefined) {
  if (!element) throw new Error("Nothing to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  });
  await settle();
}

/** This check never announces: no live region may exist in any state it can be in. */
function expectNoLiveRegion() {
  expect(container.querySelectorAll('[role="status"], [role="alert"], [aria-live]')).toHaveLength(0);
}

beforeEach(() => {
  api.fetchSettings.mockReset();
  hosts.ensureHostsAllowed.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
});

describe("ChannelHostsCheck", () => {
  it("renders nothing, and reads nothing, when the channel needs no host", async () => {
    await show({ hosts: [] });
    expect(container.innerHTML).toBe("");
    expect(api.fetchSettings).not.toHaveBeenCalled();
  });

  it("says, for each address it can't read, that it can't check that host, with no button and nothing to read", async () => {
    await show({ hosts: [], unreadable: ["Webhook URL", "Server"] });
    expect([...container.querySelectorAll("p")].map((item) => item.textContent)).toEqual([
      "GoatCitadel can't read the address in Webhook URL after it's saved, so it can't check its host. Make sure GoatCitadel may reach it.",
      "GoatCitadel can't read the address in Server after it's saved, so it can't check its host. Make sure GoatCitadel may reach it.",
    ]);
    expect(buttons()).toHaveLength(0);
    expect(api.fetchSettings).not.toHaveBeenCalled();
    expectNoLiveRegion();
  });

  it("shows the hosts it could read and the addresses it couldn't, side by side", async () => {
    api.fetchSettings.mockResolvedValue(settings(["api.line.me"]));
    await show({ hosts: LINE, unreadable: ["Webhook URL"] });
    expect(text()).toContain("GoatCitadel may reach api.line.me.");
    expect(text()).toContain("GoatCitadel can't read the address in Webhook URL after it's saved");
    expectNoLiveRegion();
  });

  it("still shows what it couldn't read while the allowlist is being read, and still offers no button", async () => {
    api.fetchSettings.mockReturnValue(new Promise(() => undefined));
    await show({ hosts: LINE, unreadable: ["Webhook URL"] });
    expect(text()).toBe(
      "GoatCitadel can't read the address in Webhook URL after it's saved, so it can't check its host. Make sure GoatCitadel may reach it.",
    );
    expect(button("Allow these hosts")).toBeUndefined();
    expectNoLiveRegion();
  });

  it("says nothing, and offers no button, while the allowlist is being read", async () => {
    api.fetchSettings.mockReturnValue(new Promise(() => undefined));
    await show({ hosts: LINE });
    expect(container.innerHTML).toBe("");
    expect(button("Allow these hosts")).toBeUndefined();
    expectNoLiveRegion();
  });

  it("lists the hosts GoatCitadel may already reach", async () => {
    api.fetchSettings.mockResolvedValue(settings(["api.line.me", "*.example.com"]));
    await show({ hosts: ["api.line.me", "chat.example.com"] });
    expect(text()).toBe("GoatCitadel may reach api.line.me, chat.example.com.");
    expect(buttons()).toHaveLength(0);
    expect(hosts.ensureHostsAllowed).not.toHaveBeenCalled();
    expectNoLiveRegion();
  });

  it("names the hosts it can't reach yet and changes nothing until the operator clicks", async () => {
    api.fetchSettings.mockResolvedValue(settings(["ntfy.sh"]));
    await show({ hosts: ["api.line.me", "ntfy.sh"] });
    expect(text()).toContain(
      "GoatCitadel can't reach these yet: api.line.me. Real messages fail until they're allowed.",
    );
    expect(text()).not.toContain("ntfy.sh");
    expect(button("Allow these hosts")).toBeDefined();
    expect(hosts.ensureHostsAllowed).not.toHaveBeenCalled();
    expectNoLiveRegion();
  });

  it("allows exactly the hosts it listed, in the workspace it was given, then reads the allowlist again", async () => {
    api.fetchSettings.mockResolvedValueOnce(settings([])).mockResolvedValueOnce(settings(["api.line.me"]));
    hosts.ensureHostsAllowed.mockResolvedValue({ kind: "allowed" });
    await show({ hosts: LINE });

    await click(button("Allow these hosts"));

    expect(hosts.ensureHostsAllowed).toHaveBeenCalledExactlyOnceWith(["api.line.me"], "default", ["api.line.me"]);
    expect(api.fetchSettings).toHaveBeenCalledTimes(2);
    expect(text()).toBe("GoatCitadel may reach api.line.me.");
    expect(button("Allow these hosts")).toBeUndefined();
    expectNoLiveRegion();
  });

  it("asks only for the missing hosts when it lists several, and shows the same list it asks for", async () => {
    api.fetchSettings.mockResolvedValue(settings(["ntfy.sh"]));
    hosts.ensureHostsAllowed.mockResolvedValue({ kind: "failed", message: "That didn't work." });
    await show({ hosts: ["ntfy.sh", "api.line.me", "api.line.me", "chat.example.com"], workspaceId: "w-7" });
    expect(text()).toContain("these yet: api.line.me, chat.example.com.");

    await click(button("Allow these hosts"));

    const [asked, workspace, shown] = hosts.ensureHostsAllowed.mock.calls[0]!;
    expect(asked).toEqual(["api.line.me", "chat.example.com"]);
    expect(workspace).toBe("w-7");
    expect(shown).toBe(asked);
  });

  it("shows the Allowing label while the change is made, and ignores a second click", async () => {
    api.fetchSettings.mockResolvedValue(settings([]));
    let finish!: (outcome: unknown) => void;
    hosts.ensureHostsAllowed.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await show({ hosts: LINE });

    await click(button("Allow these hosts"));
    const working = button("Allowing…");
    expect(working).toBeDefined();
    expect(working!.getAttribute("aria-busy")).toBe("true");
    await click(working);
    expect(hosts.ensureHostsAllowed).toHaveBeenCalledTimes(1);
    expectNoLiveRegion();

    api.fetchSettings.mockResolvedValue(settings(["api.line.me"]));
    await act(async () => finish({ kind: "allowed" }));
    await settle();
    expect(text()).toBe("GoatCitadel may reach api.line.me.");
  });

  it("sends the operator to the approval in Inbox when the page can't approve it", async () => {
    api.fetchSettings.mockResolvedValue(settings([]));
    hosts.ensureHostsAllowed.mockResolvedValue({ kind: "elsewhere", plan: { planId: "p-1" }, approvalId: "a-1" });
    await show({ hosts: LINE });

    await click(button("Allow these hosts"));

    const approve = link("Approve it in Inbox");
    expect(approve).toBeDefined();
    const target = new URL(approve!.getAttribute("href")!, "http://cockpit.invalid");
    expect(target.pathname).toBe("/inbox");
    expect(target.searchParams.get("approvalId")).toBe("a-1");
    expect(target.searchParams.get("workspaceId")).toBe("default");
    expect(link("Review it in Inbox")).toBeUndefined();
    expectNoLiveRegion();
  });

  it("sends the operator to the change in Inbox when no approval is waiting", async () => {
    api.fetchSettings.mockResolvedValue(settings([]));
    hosts.ensureHostsAllowed.mockResolvedValue({ kind: "elsewhere", plan: { planId: "p-9" } });
    await show({ hosts: LINE, workspaceId: "w-2" });

    await click(button("Allow these hosts"));

    const review = link("Review it in Inbox");
    expect(review).toBeDefined();
    const target = new URL(review!.getAttribute("href")!, "http://cockpit.invalid");
    expect(target.pathname).toBe("/inbox");
    expect(target.searchParams.get("item")).toBe("change_plan:p-9");
    expect(target.searchParams.get("workspaceId")).toBe("w-2");
    expect(link("Approve it in Inbox")).toBeUndefined();
    expectNoLiveRegion();
  });

  it("says why it failed, and lets the operator try again", async () => {
    api.fetchSettings.mockResolvedValue(settings([]));
    hosts.ensureHostsAllowed.mockResolvedValueOnce({ kind: "failed", message: "The gateway hit an error." });
    await show({ hosts: LINE });

    await click(button("Allow these hosts"));

    expect(text()).toContain("The gateway hit an error.");
    expect(button("Allow these hosts")).toBeDefined();
    expectNoLiveRegion();
  });

  it("gives the reasons a click was blocked", async () => {
    api.fetchSettings.mockResolvedValue(settings([]));
    hosts.ensureHostsAllowed.mockResolvedValue({
      kind: "blocked",
      reasons: ["GoatCitadel needs to reach a.example. Reload this page.", "GoatCitadel needs to reach b.example."],
    });
    await show({ hosts: LINE });

    await click(button("Allow these hosts"));

    expect(text()).toContain("GoatCitadel needs to reach a.example. Reload this page.");
    expect(text()).toContain("GoatCitadel needs to reach b.example.");
    expectNoLiveRegion();
  });

  it("clears the last answer when the hosts it lists change", async () => {
    api.fetchSettings.mockResolvedValue(settings([]));
    hosts.ensureHostsAllowed.mockResolvedValue({ kind: "failed", message: "The gateway hit an error." });
    await show({ hosts: LINE });
    await click(button("Allow these hosts"));
    expect(text()).toContain("The gateway hit an error.");

    await show({ hosts: ["api.line.me", "chat.example.com"] });

    expect(text()).not.toContain("The gateway hit an error.");
    expect(text()).toContain("these yet: api.line.me, chat.example.com.");
  });

  it("says it can't check, offers Try again and no Allow button, when the allowlist can't be read", async () => {
    api.fetchSettings.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(settings(["api.line.me"]));
    await show({ hosts: LINE });
    expect(text()).toContain(HOSTS_UNKNOWN);
    expect(button("Allow these hosts")).toBeUndefined();
    expectNoLiveRegion();

    await click(button("Try again"));

    expect(text()).toBe("GoatCitadel may reach api.line.me.");
    expect(hosts.ensureHostsAllowed).not.toHaveBeenCalled();
  });
});
