import { StrictMode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpsSavedBoardRecord } from "@goatcitadel/contracts";
import { useBoardEditor } from "./use-board-editor";
import { __resetBoardMutationsForTests } from "./board-mutation-state";
import { __resetSessionDraftsForTests, hasSessionDraft } from "../library/session-drafts";
import { boardFixture, deferred } from "./board-mutation.test-support";
const api = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), list: vi.fn(), create: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/ops-saved-boards", () => ({
  fetchOpsSavedBoard: api.get,
  updateOpsSavedBoard: api.update,
  fetchOpsSavedBoards: api.list,
  createOpsSavedBoard: api.create,
}));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({
  getGatewayApiBaseUrl: () => "http://fixture",
}));
let renderer: ReactTestRenderer | undefined, owner: ReturnType<typeof useBoardEditor>;
const onSaved = vi.fn();
const draftKey = "ops-board:workspace-a:board-a";
function Harness({
  workspace = "workspace-a",
  board = boardFixture(),
}: {
  workspace?: string;
  board?: OpsSavedBoardRecord;
}) {
  owner = useBoardEditor(workspace, board, onSaved);
  return null;
}
async function mount(workspace = "workspace-a") {
  await act(async () => {
    renderer = create(
      <StrictMode>
        <Harness workspace={workspace} />
      </StrictMode>,
    );
  });
}
async function review(name = "Submitted name") {
  await act(async () => owner.setDraft({ ...owner.draft, name }));
  await act(async () => owner.requestReview());
}
beforeEach(() => {
  vi.resetAllMocks();
  __resetBoardMutationsForTests();
  __resetSessionDraftsForTests();
  api.get.mockResolvedValue(boardFixture());
  api.update.mockImplementation(async (_id: string, input: { name: string }) => {
    const saved = boardFixture({ name: input.name, revision: 3 });
    api.get.mockResolvedValue(saved);
    return saved;
  });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
});
it("settles a real StrictMode mounted save once, after two exact reads", async () => {
  await mount();
  await review();
  await act(async () => owner.save());
  expect(api.update).toHaveBeenCalledTimes(1);
  expect(api.get).toHaveBeenCalledTimes(2);
  expect(onSaved).toHaveBeenCalledTimes(1);
  expect(owner.attempt.phase).toBe("idle");
  expect(hasSessionDraft(draftKey)).toBe(false);
});
it.each(["edit", "away-back", "unmount"] as const)(
  "cancels %s while the canonical preflight is pending",
  async (change) => {
    await mount();
    await review();
    const pending = deferred<OpsSavedBoardRecord>();
    api.get.mockReturnValue(pending.promise);
    let saving!: Promise<void>;
    await act(async () => {
      saving = owner.save();
    });
    if (change === "edit") {
      await act(async () => owner.setDraft({ ...owner.draft, name: "Another draft" }));
      await act(async () => owner.setDraft({ ...owner.draft, name: "Submitted name" }));
    } else if (change === "away-back") {
      await act(async () =>
        renderer!.update(
          <StrictMode>
            <Harness workspace="workspace-b" />
          </StrictMode>,
        ),
      );
      await act(async () =>
        renderer!.update(
          <StrictMode>
            <Harness />
          </StrictMode>,
        ),
      );
    } else {
      await act(async () => renderer!.unmount());
      renderer = undefined;
    }
    await act(async () => {
      pending.resolve(boardFixture());
      await saving;
    });
    expect(api.update).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  },
);
it("retains uncertainty through unmount and remount and never dispatches a second save", async () => {
  api.update.mockRejectedValue(new Error("lost response"));
  await mount();
  await review();
  await act(async () => owner.save());
  await act(async () => renderer!.unmount());
  renderer = undefined;
  await mount();
  expect(owner.attempt.phase).toBe("uncertain");
  expect(owner.draft.name).toBe("Submitted name");
  await act(async () => {
    owner.requestReview();
    await owner.save();
  });
  expect(api.update).toHaveBeenCalledTimes(1);
});
it.each([false, true])("acknowledges a late confirmed origin save, preserving newer input=%s", async (newer) => {
  const pending = deferred<OpsSavedBoardRecord>();
  api.update.mockReturnValue(pending.promise);
  await mount();
  await review();
  let saving!: Promise<void>;
  await act(async () => {
    saving = owner.save();
  });
  expect(api.update).toHaveBeenCalledTimes(1);
  await act(async () => renderer!.unmount());
  renderer = undefined;
  if (newer) {
    await mount();
    await act(async () => owner.setDraft({ ...owner.draft, name: "Newer typing" }));
  }
  const saved = boardFixture({ name: "Submitted name", revision: 3 });
  api.get.mockResolvedValue(saved);
  await act(async () => {
    pending.resolve(saved);
    await saving;
  });
  expect(onSaved).not.toHaveBeenCalled();
  expect(hasSessionDraft(draftKey)).toBe(newer);
  if (!newer) await mount();
  expect(owner.attempt.phase).toBe("idle");
  if (newer) expect(owner.draft.name).toBe("Newer typing");
});
it("cancels an explicit review before dispatch without clearing the retained draft", async () => {
  await mount();
  await review();
  await act(async () => owner.cancelReview());
  await act(async () => owner.save());
  expect(api.update).not.toHaveBeenCalled();
  expect(hasSessionDraft(draftKey)).toBe(true);
});
