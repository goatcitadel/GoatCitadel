// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  notifyGatewayAccessChanged,
  setGatewayCallerScope,
} from "@goatcitadel/mission-control-shared/api/access-scope";
import { useIntegrationConnectionReview } from "./useIntegrationConnectionReview";

const apply = vi.fn();
const fetchMock = vi.fn<typeof fetch>();
const connectionId = "integration-fixture";
const connection = { connectionId, revision: "a".repeat(64) };
let root: Root;
let review: ReturnType<typeof useIntegrationConnectionReview>;

function Review() {
  review = useIntegrationConnectionReview("workspace-fixture", connectionId, apply);
  return null;
}

beforeEach(() => {
  apply.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  setGatewayCallerScope("caller-one");
  root = createRoot(document.createElement("div"));
  act(() => root.render(<Review />));
});

afterEach(() => {
  act(() => root.unmount());
  setGatewayCallerScope("");
  vi.unstubAllGlobals();
});

it("ignores an old caller's 404 and keeps the connection review blocked until a fresh read", async () => {
  let respond!: (response: Response) => void;
  fetchMock.mockReturnValueOnce(
    new Promise<Response>((resolve) => {
      respond = resolve;
    }),
  );
  let pending!: Promise<void>;
  act(() => {
    pending = review.refresh();
  });
  expect(fetchMock).toHaveBeenCalledOnce();

  act(() => setGatewayCallerScope("caller-two"));
  await act(async () => {
    respond(Response.json({ error: "Connection missing" }, { status: 404 }));
    await pending;
  });

  expect(apply).not.toHaveBeenCalled();
  expect(review).toMatchObject({ required: true, loading: false, missing: false });
  expect(review.error).toContain("Your access changed");
  act(() => review.accept());
  expect(review.required).toBe(true);

  fetchMock.mockResolvedValueOnce(Response.json(connection));
  await act(() => review.refresh());
  expect(apply).toHaveBeenCalledExactlyOnceWith(connectionId, connection);
  act(() => review.accept());
  expect(review.required).toBe(false);
});

it("invalidates an already-loaded review when credentials change", async () => {
  fetchMock.mockResolvedValueOnce(Response.json(connection));
  await act(() => review.refresh());
  expect(review).toMatchObject({ required: true, loading: false, error: null });
  const previousReview = review;

  act(() => {
    notifyGatewayAccessChanged();
    previousReview.accept();
  });

  expect(previousReview.isCurrent()).toBe(false);
  expect(review).toMatchObject({ required: true, loading: false, missing: false });
  expect(review.error).toContain("Your access changed");
});

it("continues to report deletion for a 404 from the current caller", async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ error: "Connection missing" }, { status: 404 }));
  await act(() => review.refresh());
  expect(apply).toHaveBeenCalledExactlyOnceWith(connectionId, null);
  expect(review).toMatchObject({ required: true, loading: false, missing: true });
});
