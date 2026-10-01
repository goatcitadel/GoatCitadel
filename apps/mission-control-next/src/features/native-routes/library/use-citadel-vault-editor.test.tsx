import { StrictMode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CitadelVaultSnapshot } from "@goatcitadel/contracts";
import { useCitadelVaultEditor } from "./use-citadel-vault-editor";
import { __resetSessionDraftsForTests } from "./session-drafts";
import { __resetCitadelVaultAttemptsForTests, vaultAttempt } from "./citadel-vault-state";
const api = vi.hoisted(() => ({ read: vi.fn(), store: vi.fn(), remove: vi.fn(), reveal: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  getCitadelVaultSnapshot: api.read,
  storeCitadelVaultSecret: api.store,
  deleteCitadelVaultSecret: api.remove,
  revealCitadelVaultSecret: api.reveal,
  isApiRequestError: (value: { kind?: string }) => value?.kind === "http",
}));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({
  getGatewayApiBaseUrl: () => "http://fixture",
}));
let owner: CitadelVaultSnapshot,
  control!: ReturnType<typeof useCitadelVaultEditor>,
  renderer: ReactTestRenderer | undefined;
const initial = (): CitadelVaultSnapshot => ({ citadelId: "citadel", revision: "a".repeat(64), items: [] });
const stored = (): CitadelVaultSnapshot => ({
  ...initial(),
  revision: "b".repeat(64),
  items: [
    { secretId: "secret", secretName: "Example", createdAt: "2026-09-30T00:00:00Z", updatedAt: "2026-09-30T00:00:00Z" },
  ],
});
function Harness({ scope = "citadel" }: { scope?: string }) {
  control = useCitadelVaultEditor(scope);
  return null;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function mount(scope = "citadel") {
  await act(async () => {
    renderer = create(
      <StrictMode>
        <Harness scope={scope} />
      </StrictMode>,
    );
  });
}
async function draft() {
  await act(async () => {
    control.openForm();
    control.setDraft({ name: "Example", value: "synthetic-input" });
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  __resetSessionDraftsForTests();
  __resetCitadelVaultAttemptsForTests();
  owner = initial();
  api.read.mockImplementation(async (id: string) => (id === "citadel" ? owner : { ...initial(), citadelId: id }));
  api.store.mockImplementation(async () => {
    owner = stored();
    return owner;
  });
  api.remove.mockImplementation(async () => {
    owner = { ...initial(), revision: "c".repeat(64) };
    return owner;
  });
  api.reveal.mockResolvedValue("synthetic-opened-value");
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
});
it("confirms a StrictMode store through exact receipt and independent metadata without revealing bytes", async () => {
  await mount();
  await draft();
  const readCount = api.read.mock.calls.length;
  await act(async () => {
    await control.store();
  });
  expect(api.store).toHaveBeenCalledExactlyOnceWith("citadel", "Example", "synthetic-input", "a".repeat(64));
  expect(api.read.mock.calls.length - readCount).toBe(2);
  expect(control.draft).toEqual({ name: "", value: "" });
  expect(control.formOpen).toBe(false);
  expect(control.vault.snapshot).toEqual(owner);
  expect(api.reveal).not.toHaveBeenCalled();
});
it.each(["unmount", "away-back", "close"])("cancels before dispatch after %s during preflight", async (change) => {
  await mount();
  await draft();
  const read = deferred<CitadelVaultSnapshot>();
  api.read.mockReturnValueOnce(read.promise);
  let pending!: Promise<boolean>;
  await act(async () => {
    pending = control.store();
  });
  if (change === "unmount") {
    await act(async () => renderer!.unmount());
    renderer = undefined;
  }
  if (change === "away-back") {
    await act(async () =>
      renderer!.update(
        <StrictMode>
          <Harness scope="foreign" />
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
  }
  if (change === "close") {
    await act(async () => control.closeDetails());
    await act(async () => control.leave.dialogProps.onContinue());
  }
  await act(async () => {
    read.resolve(initial());
    await pending;
  });
  expect(api.store).not.toHaveBeenCalled();
});
it("acknowledges a confirmed submitted draft after unmount without wiping newer input", async () => {
  await mount();
  await draft();
  const write = deferred<CitadelVaultSnapshot>();
  api.store.mockReturnValueOnce(write.promise);
  let pending!: Promise<boolean>;
  await act(async () => {
    pending = control.store();
  });
  await act(async () => renderer!.unmount());
  renderer = undefined;
  await mount();
  await act(async () => control.setDraft((value) => ({ ...value, value: "newer-input" })));
  await act(async () => {
    owner = stored();
    write.resolve(owner);
    await pending;
  });
  expect(control.draft.value).toBe("newer-input");
  expect(control.secretDraft.isDirty).toBe(true);
  expect(control.secretDraft.baseRevision).toBe(owner.revision);
  expect(api.store).toHaveBeenCalledTimes(1);
});
it.each(["name", "value", "name-aba", "value-aba"])(
  "cancels the old submission when %s changes during preflight",
  async (change) => {
    await mount();
    await draft();
    const read = deferred<CitadelVaultSnapshot>();
    api.read.mockReturnValueOnce(read.promise);
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = control.store();
    });
    const field = change.startsWith("name") ? "name" : "value",
      original = control.draft[field];
    await act(async () => control.setDraft((value) => ({ ...value, [field]: "changed-input" })));
    if (change.endsWith("-aba")) await act(async () => control.setDraft((value) => ({ ...value, [field]: original })));
    await act(async () => {
      read.resolve(initial());
      await pending;
    });
    expect(api.store).not.toHaveBeenCalled();
    expect(control.vault.locked).toBe(false);
  },
);
it("clears only the acknowledged origin input after a late success and blocks duplicate admission", async () => {
  await mount();
  await draft();
  const write = deferred<CitadelVaultSnapshot>();
  api.store.mockReturnValueOnce(write.promise);
  let pending!: Promise<boolean>;
  await act(async () => {
    pending = control.store();
    void control.store();
  });
  await act(async () => renderer!.unmount());
  renderer = undefined;
  await act(async () => {
    owner = stored();
    write.resolve(owner);
    await pending;
  });
  await mount();
  expect(control.draft.value).toBe("");
  expect(control.secretDraft.isDirty).toBe(false);
  expect(api.store).toHaveBeenCalledTimes(1);
});
it("retains ambiguous admission across unmount, foreign scope and return without retaining secret bytes in the lock", async () => {
  await mount();
  await draft();
  api.store.mockRejectedValueOnce(new Error("synthetic-input upstream echo"));
  await act(async () => {
    await control.store();
  });
  expect(control.vault.error).toMatch(/outcome is unconfirmed/);
  expect(JSON.stringify(vaultAttempt(control.vault.key))).not.toContain("synthetic-input");
  await act(async () => renderer!.unmount());
  renderer = undefined;
  await mount("foreign");
  expect(control.vault.locked).toBe(false);
  await act(async () =>
    renderer!.update(
      <StrictMode>
        <Harness />
      </StrictMode>,
    ),
  );
  await act(async () => {
    await control.store();
    await control.refresh();
  });
  expect(control.vault.locked).toBe(true);
  expect(api.store).toHaveBeenCalledTimes(1);
});
it.each(["foreign", "extra-item", "wrong-name", "readback"])(
  "withholds mismatched %s acknowledgement",
  async (change) => {
    await mount();
    await draft();
    api.store.mockImplementationOnce(async () => {
      const result = stored();
      if (change === "foreign") result.citadelId = "foreign";
      if (change === "wrong-name") result.items[0]!.secretName = "Other";
      if (change === "extra-item") result.items.push({ ...result.items[0]!, secretId: "extra", secretName: "Extra" });
      owner = change === "readback" ? initial() : result;
      return result;
    });
    await act(async () => {
      await control.store();
    });
    expect(control.vault.locked).toBe(true);
    expect(control.draft.value).toBe("synthetic-input");
  },
);
it("rejects stale metadata before write and requires an explicit reviewed retry", async () => {
  await mount();
  await draft();
  owner = stored();
  await act(async () => {
    await control.store();
  });
  expect(api.store).not.toHaveBeenCalled();
  expect(control.reviewRequired).toBe(true);
  await act(async () => control.acceptReview());
  await act(async () => {
    await control.store();
  });
  expect(control.pendingStore?.draft.value).toBe("synthetic-input");
  expect(api.store).not.toHaveBeenCalled();
  await act(async () => control.cancelStore());
  expect(api.store).not.toHaveBeenCalled();
});
it("withholds a reveal changed during transport and clears revealed values after refresh", async () => {
  owner = stored();
  await mount();
  await act(async () => control.inspect("secret"));
  api.reveal.mockImplementationOnce(async () => {
    owner = { ...stored(), revision: "c".repeat(64) };
    return "synthetic-secret";
  });
  await act(async () => control.reveal("secret"));
  expect(control.revealed).toEqual({});
  await act(async () => control.refresh());
  await act(async () => control.reveal("secret"));
  expect(control.revealed.secret).toBe("synthetic-opened-value");
  await act(async () => control.refresh());
  expect(control.revealed).toEqual({});
});
it("hides a revealed value after 30 seconds", async () => {
  vi.useFakeTimers();
  owner = stored();
  await mount();
  await act(async () => control.inspect("secret"));
  await act(async () => control.reveal("secret"));
  expect(control.revealed.secret).toBe("synthetic-opened-value");
  await act(async () => {
    vi.advanceTimersByTime(30_000);
  });
  expect(control.revealed).toEqual({});
});
