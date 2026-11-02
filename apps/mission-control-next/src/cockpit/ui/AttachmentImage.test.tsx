// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentImage } from "./AttachmentImage";

let root: Root;
let container: HTMLDivElement;
let created: string[];
let revoked: string[];
const responses = new Map<string, () => Promise<Response>>();

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  created = [];
  revoked = [];
  responses.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn((input: unknown) => {
      const id = decodeURIComponent(String(input).split("/attachments/")[1]!.split("/")[0]!);
      return responses.get(id)!();
    }),
  );
  URL.createObjectURL = vi.fn(() => {
    const url = `blob:test/${created.length + 1}`;
    created.push(url);
    return url;
  });
  URL.revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const ok = () => Promise.resolve(new Response(new Blob(["x"])));
const render = (id: string) => act(async () => root.render(<AttachmentImage attachmentId={id} alt="Shot" />));

describe("AttachmentImage", () => {
  it("keeps the previous image until the next has loaded, then revokes the old URL", async () => {
    responses.set("a", ok);
    let release!: () => void;
    responses.set("b", () => new Promise((resolve) => (release = () => resolve(new Response(new Blob(["y"]))))));
    await render("a");
    await vi.waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:test/1"));
    await render("b");
    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:test/1");
    expect(revoked).toEqual([]);
    await act(async () => release());
    await vi.waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:test/2"));
    expect(revoked).toEqual(["blob:test/1"]);
    act(() => root.unmount());
    expect(revoked).toEqual(["blob:test/1", "blob:test/2"]);
    root = createRoot(container);
  });

  it("says the image could not be loaded without a status code", async () => {
    responses.set("bad", () => Promise.resolve(new Response("no", { status: 500 })));
    await render("bad");
    await vi.waitFor(() => expect(container.textContent).toContain("The image couldn't be loaded."));
    expect(container.textContent).not.toContain("500");
  });
});
