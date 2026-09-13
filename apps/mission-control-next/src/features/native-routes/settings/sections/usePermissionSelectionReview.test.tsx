import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PermissionProfileSelectionReview } from "@goatcitadel/contracts";
import { usePermissionSelectionReview } from "./usePermissionSelectionReview";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({ reviewPermissionProfileSelection: mocks.request }));
let editor: ReturnType<typeof usePermissionSelectionReview>;
let renderer: ReactTestRenderer | undefined;
function Harness({ owner = "workspace:a:profile:one" }: { owner?: string }) { editor = usePermissionSelectionReview(owner); return null; }
const input = { operation: "defaults" as const, scope: "workspace" as const, scopeRef: "a", defaultForSurfaces: ["chat" as const] };
const snapshot = (revision: string): PermissionProfileSelectionReview => ({ revision, input, target: { workspaceId: "a" }, activeProfiles: [] });
beforeEach(() => { mocks.request.mockReset(); });
afterEach(async () => { await act(async () => renderer?.unmount()); renderer = undefined; });

it("discards a late review when the workspace, profile, view or draft key changes", async () => {
  let resolve!: (value: PermissionProfileSelectionReview) => void;
  mocks.request.mockReturnValue(new Promise((done) => { resolve = done; }));
  await act(async () => { renderer = create(<Harness />); });
  let pending!: Promise<void>;
  await act(async () => { pending = editor.request(input); });
  expect(editor.pending).toBe(true);
  await act(async () => { renderer!.update(<Harness owner="workspace:b:profile:two" />); });
  await act(async () => { resolve(snapshot("old")); await pending; });
  expect(editor.review).toBeUndefined();
  expect(editor.pending).toBe(false);
});

it("uses only the most recent review request and invalidates an explicitly cancelled review", async () => {
  const resolvers: Array<(value: PermissionProfileSelectionReview) => void> = [];
  mocks.request.mockImplementation(() => new Promise((resolve) => { resolvers.push(resolve); }));
  await act(async () => { renderer = create(<Harness />); });
  let first!: Promise<void>; let second!: Promise<void>;
  await act(async () => { first = editor.request(input); second = editor.request(input); });
  await act(async () => { resolvers[1]!(snapshot("current")); await second; });
  await act(async () => { resolvers[0]!(snapshot("stale")); await first; });
  expect(editor.review?.revision).toBe("current");
  await act(async () => { editor.clear(); });
  expect(editor.review).toBeUndefined();
});

it("does not keep a review after a failed refresh", async () => {
  mocks.request.mockResolvedValueOnce(snapshot("before"));
  await act(async () => { renderer = create(<Harness />); });
  await act(async () => { await editor.request(input); });
  mocks.request.mockRejectedValueOnce(new Error("Selection unavailable"));
  await act(async () => { await editor.request(input); });
  expect(editor.review).toBeUndefined();
  expect(editor.error).toContain("Selection unavailable");
});
