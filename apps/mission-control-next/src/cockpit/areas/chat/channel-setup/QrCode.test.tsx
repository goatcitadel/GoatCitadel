// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { encode } from "uqr";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QrCode } from "./QrCode";

const VALUE = "https://t.me/BotFather";
const LABEL = "QR code that opens BotFather";

let root: Root;
let container: HTMLDivElement;

async function mount(value = VALUE, label = LABEL) {
  await act(async () => {
    root.render(<QrCode value={value} label={label} />);
  });
  return container.querySelector("svg")!;
}

/** The grid a path draws: each `M x y h w v 1 h -w z` run darkens `w` modules from column x in row y. */
function drawnGrid(path: SVGPathElement, size: number): boolean[][] {
  const grid = Array.from({ length: size }, () => Array.from({ length: size }, () => false));
  for (const run of (path.getAttribute("d") ?? "").matchAll(/M(\d+) (\d+)h(\d+)v1h-\3z/g)) {
    const [x, y, width] = [Number(run[1]), Number(run[2]), Number(run[3])];
    for (let column = x; column < x + width; column += 1) grid[y]![column] = true;
  }
  return grid;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("QrCode", () => {
  it("is an image with the label it was given", async () => {
    const svg = await mount();
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toBe(LABEL);
  });

  it("is square and its view box matches the matrix, quiet border included", async () => {
    const size = encode(VALUE, { ecc: "M", border: 2 }).size;
    const svg = await mount();
    expect(svg.getAttribute("viewBox")).toBe(`0 0 ${size} ${size}`);
  });

  it("draws every dark module, and only those, in one path", async () => {
    const { data, size } = encode(VALUE, { ecc: "M", border: 2 });
    const svg = await mount();
    const paths = svg.querySelectorAll("path");
    expect(paths).toHaveLength(1);
    expect(drawnGrid(paths[0]!, size)).toEqual(data);
  });

  it("draws a different code for a different value", async () => {
    const first = (await mount()).querySelector("path")!.getAttribute("d");
    const second = (await mount("https://t.me/MyGoatBot?start=abc123XYZ9")).querySelector("path")!.getAttribute("d");
    expect(second).not.toBe(first);
  });

  it("stays dark on a light square in both themes", async () => {
    const svg = await mount();
    // Fixed colours, not theme tokens: a code inverted by the dark theme does not scan.
    expect(svg.querySelector("rect")?.getAttribute("fill")).toBe("white");
    expect(svg.querySelector("path")?.getAttribute("fill")).toBe("black");
  });

  it("injects no markup and adds no live region", async () => {
    await mount();
    expect(container.querySelectorAll("script, foreignObject, style")).toHaveLength(0);
    expect(container.querySelector('[role="status"], [role="alert"], [aria-live]')).toBeNull();
  });
});
