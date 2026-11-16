import type { ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import type { CitadelRecord, WorkspaceRecord } from "@goatcitadel/contracts";
import type { DirectoryLifecycleReview as Review } from "../../../features/native-routes/settings/directory-lifecycle-binding";
import { DirectoryLifecycleReview } from "./DirectoryLifecycleReview";

vi.mock("../../ui/Dialog", () => ({
  Dialog: ({
    open,
    children,
    title,
    description,
  }: {
    open: boolean;
    children: ReactNode;
    title: string;
    description?: string;
  }) =>
    open ? (
      <section aria-label={title}>
        <p>{description}</p>
        {children}
      </section>
    ) : null,
}));
let renderer: ReactTestRenderer | undefined;
function text(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map(text).join("");
}
async function mount(review: Review) {
  const lifecycle = { review, cancel: vi.fn(), confirm: vi.fn(), pending: false, available: true, checking: false };
  await act(async () => {
    renderer = create(<DirectoryLifecycleReview lifecycle={lifecycle as never} />);
  });
  return text(renderer!.root);
}
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
});

it("U-ST-028: the archive review shows the name and the change, not ids or versions", async () => {
  const record = {
    workspaceId: "ws_8f3a91c2",
    name: "Studio",
    revision: "a".repeat(64),
    lifecycleStatus: "active",
  } as unknown as WorkspaceRecord;
  const shown = await mount({ action: "archive", kind: "workspace", record, scope: "cit_44d0b1" });
  expect(shown).toContain("Review the saved record before archiving or restoring it.");
  expect(shown).toContain("Studio");
  expect(shown).toContain("Active → Archived");
  expect(shown).not.toMatch(/ws_|cit_|Record ID|Version|a{20}/);
});

it("restoring a Citadel reads Archived to Active without ids", async () => {
  const record = {
    citadelId: "cit_44d0b1",
    name: "Home",
    revision: "b".repeat(64),
    lifecycleStatus: "archived",
  } as unknown as CitadelRecord;
  const shown = await mount({ action: "restore", kind: "citadel", record });
  expect(shown).toContain("Archived → Active");
  expect(shown).not.toMatch(/cit_|Record ID|Version/);
});
