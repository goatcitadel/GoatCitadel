// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PUBLIC_WEB_ADDRESS_NOT_HTTPS, type ApprovalStatus } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetSettingsChangesForTests } from "../../../features/native-routes/settings/use-settings-change";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";

const api = vi.hoisted(() => ({ fetchSettings: vi.fn(), patchSettings: vi.fn(), fetchChangePlan: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchSettings: api.fetchSettings,
  patchSettings: api.patchSettings,
  fetchChangePlan: api.fetchChangePlan,
  isApiRequestError: (value: unknown) => Boolean(value && typeof value === "object" && "status" in value),
}));
// The dialog itself is covered in SettingsApprovalDialog.test.tsx; here it only reports a decision.
vi.mock("./SettingsApprovalDialog", () => ({
  SettingsApprovalDialog: ({ onResolved }: { onResolved: (status: ApprovalStatus) => void }) => (
    <button type="button" onClick={() => onResolved("approved")}>
      Decide approved
    </button>
  ),
}));

import { PublicWebAddressField, usePublicWebAddressSettings } from "./PublicWebAddressField";

const HELP =
  "The https:// address where Meta and other services can reach this GoatCitadel. Use your own domain, reverse proxy or tunnel; GoatCitadel doesn't provide one.";

/** What the Gateway holds. A save changes it only when a test says the change was applied. */
let server: { revision: number; publicWebAddress?: string };

const planFor = (status: "awaiting_approval" | "completed", address: string | null) => ({
  planId: "plan-1",
  status,
  revision: 1,
  kind: "runtime_configuration",
  origin: { workspaceId: "default", surface: "settings" },
  request: {
    kind: "runtime_configuration",
    change: { operation: "public_web_address_configuration", config: { publicWebAddress: address } },
  },
  target: { ownerId: "runtime_settings", resourceId: "public_web_address_configuration", expectedRevision: 2 },
  summary: status === "completed" ? "Public web address saved." : "Approval required",
});

const awaitingApprovalReceipt = {
  planId: "plan-1",
  status: "awaiting_approval",
  revision: 1,
  summary: "Approval required",
  requiredAction: { kind: "approval", approvalId: "approval-1" },
};

function Harness({ onSaved }: { onSaved?: (address: string) => void }) {
  const settings = usePublicWebAddressSettings();
  return <PublicWebAddressField settings={settings} {...(onSaved ? { onSaved } : {})} />;
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

async function show(element: React.ReactElement = <Harness />) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <CockpitNavigationProvider>{element}</CockpitNavigationProvider>
      </QueryClientProvider>,
    ),
  );
}

const input = () => container.querySelector<HTMLInputElement>("input")!;
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);

async function type(value: string) {
  await act(async () => {
    // React tracks the value itself, so go through the native setter the way a keystroke does.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  server = { revision: 2, publicWebAddress: "https://old.example.com" };
  api.fetchSettings.mockImplementation(async () => ({ ...server }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
  __resetSettingsChangesForTests();
  __resetSessionDraftsForTests();
  vi.resetAllMocks();
});

describe("PublicWebAddressField", () => {
  it("shows the saved address and saves a new one through Settings' approval", async () => {
    const onSaved = vi.fn();
    api.patchSettings.mockResolvedValue({ ...server, changePlanReceipt: awaitingApprovalReceipt });
    api.fetchChangePlan.mockResolvedValue(planFor("awaiting_approval", "https://goat.example.com"));
    await show(<Harness onSaved={onSaved} />);
    await vi.waitFor(() => expect(input().value).toBe("https://old.example.com"));
    expect(container.querySelector("label")?.textContent).toBe("Public web address");

    await type("https://Goat.example.com/");
    await act(async () => button("Save address")!.click());

    // The Gateway tidies the address; the field sends what was typed and trusts the Gateway's version.
    await vi.waitFor(() =>
      expect(api.patchSettings).toHaveBeenCalledWith({
        expectedRevision: 2,
        publicWebAddress: "https://Goat.example.com/",
      }),
    );
    // The same in-place approval Firecrawl's address uses; nothing is saved until it is decided.
    await vi.waitFor(() => expect(button("Decide approved")).toBeDefined());
    expect(container.textContent).toContain("draft remains unsaved");
    expect(onSaved).not.toHaveBeenCalled();

    server = { revision: 3, publicWebAddress: "https://goat.example.com" };
    api.fetchChangePlan.mockResolvedValue(planFor("completed", "https://goat.example.com"));
    await act(async () => button("Decide approved")!.click());

    await vi.waitFor(() => expect(container.textContent).toContain("Change saved and confirmed."));
    expect(input().value).toBe("https://goat.example.com");
    expect(onSaved).toHaveBeenCalledExactlyOnceWith("https://goat.example.com");
  });

  it("takes the address the Gateway tidied as the one that was typed when the save applies at once", async () => {
    const onSaved = vi.fn();
    api.patchSettings.mockImplementation(async () => {
      server = { revision: 3, publicWebAddress: "https://goat.example.com" };
      return { ...server };
    });
    await show(<Harness onSaved={onSaved} />);
    await vi.waitFor(() => expect(input().value).toBe("https://old.example.com"));

    await type("  https://Goat.example.com/  ");
    await act(async () => button("Save address")!.click());

    await vi.waitFor(() => expect(container.textContent).toContain("Public web address saved."));
    expect(container.textContent).not.toContain("uncertain");
    expect(input().value).toBe("https://goat.example.com");
    expect(button("Save address")!.disabled).toBe(true);
    expect(onSaved).toHaveBeenCalledExactlyOnceWith("https://goat.example.com");
  });

  it("says what's wrong before saving", async () => {
    await show();
    await vi.waitFor(() => expect(input().value).toBe("https://old.example.com"));

    await type("http://goat.example.com");

    const problem = container.querySelector('[id$="-error"]')!;
    expect(problem.textContent).toBe(PUBLIC_WEB_ADDRESS_NOT_HTTPS);
    expect(input().getAttribute("aria-describedby")).toContain(problem.id);
    expect(input().getAttribute("aria-invalid")).toBe("true");
    expect(button("Save address")!.disabled).toBe(true);
    expect(api.patchSettings).not.toHaveBeenCalled();
  });

  it("explains what the address is for, and that GoatCitadel doesn't provide one", async () => {
    await show();
    await vi.waitFor(() => expect(input().value).toBe("https://old.example.com"));
    const help = container.querySelector(`[id="${input().getAttribute("aria-describedby")}"]`);
    expect(help?.textContent).toBe(HELP);
  });

  it("clears the address", async () => {
    api.patchSettings.mockResolvedValue({ ...server, changePlanReceipt: awaitingApprovalReceipt });
    api.fetchChangePlan.mockResolvedValue(planFor("awaiting_approval", null));
    await show();
    await vi.waitFor(() => expect(input().value).toBe("https://old.example.com"));

    await act(async () => button("Clear")!.click());

    await vi.waitFor(() =>
      expect(api.patchSettings).toHaveBeenCalledWith({ expectedRevision: 2, publicWebAddress: null }),
    );
    expect(api.patchSettings).toHaveBeenCalledTimes(1);
    expect(input().value).toBe("");
  });

  it("clears at once when the change applies without an approval, and doesn't report an address saved", async () => {
    const onSaved = vi.fn();
    api.patchSettings.mockImplementation(async () => {
      server = { revision: 3 };
      return { ...server };
    });
    await show(<Harness onSaved={onSaved} />);
    await vi.waitFor(() => expect(input().value).toBe("https://old.example.com"));

    await act(async () => button("Clear")!.click());

    await vi.waitFor(() => expect(container.textContent).toContain("Public web address saved."));
    expect(api.patchSettings).toHaveBeenCalledExactlyOnceWith({ expectedRevision: 2, publicWebAddress: null });
    expect(input().value).toBe("");
    expect(onSaved).not.toHaveBeenCalled();
    expect(button("Clear")!.disabled).toBe(true);
  });

  it("has nothing to clear when no address is saved", async () => {
    server = { revision: 2 };
    await show();
    await vi.waitFor(() => expect(input()).not.toBeNull());
    expect(input().value).toBe("");
    expect(button("Clear")!.disabled).toBe(true);
    expect(button("Save address")!.disabled).toBe(true);
  });

  it("shows only a loading line until the settings are read", async () => {
    await show(<PublicWebAddressField settings={undefined} />);
    expect(container.querySelector("input")).toBeNull();
    expect(container.textContent).toBe("Loading the public web address…");
    expect(container.querySelector('[role="status"], [role="alert"], [aria-live]')).toBeNull();
  });
});
