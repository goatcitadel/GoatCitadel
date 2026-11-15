// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChannelSetupFieldDefinition } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelSenderListField } from "./ChannelSenderListField";

const api = vi.hoisted(() => ({ fetchChannelDroppedSenders: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", async (original) => ({
  ...(await original<object>()),
  ...api,
}));

const field: ChannelSetupFieldDefinition = {
  key: "allowedSenders",
  label: "Allowed sender identities",
  type: "sender-list",
  required: false,
  explanation: "Who may start a conversation.",
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.resetAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ChannelSenderListField
          connectionId="conn-1"
          field={field}
          value={[]}
          id="senders"
          describedBy="senders-help"
          disabled={false}
          inputClassName="input"
          onChange={vi.fn()}
        />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("the sender list of a saved connection", () => {
  it("reads the senders that connection turned away and offers them", async () => {
    api.fetchChannelDroppedSenders.mockResolvedValue({
      connectionId: "conn-1",
      items: [{ senderId: "U2", droppedAt: new Date().toISOString() }],
    });
    await mount();
    expect(api.fetchChannelDroppedSenders).toHaveBeenCalledWith("conn-1");
    expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Allow U2"]);
  });

  it("shows only the plain list when the read fails", async () => {
    api.fetchChannelDroppedSenders.mockRejectedValue(new Error("unavailable"));
    await mount();
    expect(container.querySelector("textarea")).not.toBeNull();
    expect(container.querySelector("h4")).toBeNull();
  });
});
