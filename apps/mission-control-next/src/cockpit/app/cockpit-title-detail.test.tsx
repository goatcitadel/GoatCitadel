// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useCockpitTitleDetail, useCockpitTitleDetailValue } from "./cockpit-title-detail";

let root: Root;
let container: HTMLDivElement;

function Reader() {
  return <output>{useCockpitTitleDetailValue() ?? "none"}</output>;
}
function Setter({ detail }: { detail: string | undefined }) {
  useCockpitTitleDetail(detail);
  return null;
}
const shown = () => container.querySelector("output")!.textContent;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("shows the newest caller, falls back to the older one, then to nothing", async () => {
  const render = (older: boolean, newer: boolean) =>
    act(async () =>
      root.render(
        <>
          <Reader />
          {older ? <Setter detail="Older" /> : null}
          {newer ? <Setter detail="Newer" /> : null}
        </>,
      ),
    );
  await render(true, false);
  expect(shown()).toBe("Older");
  await render(true, true);
  expect(shown()).toBe("Newer");
  await render(true, false);
  expect(shown()).toBe("Older");
  await render(false, false);
  expect(shown()).toBe("none");
});

it("follows a changed detail and ignores an empty one", async () => {
  await act(async () =>
    root.render(
      <>
        <Reader />
        <Setter detail="First" />
      </>,
    ),
  );
  expect(shown()).toBe("First");
  await act(async () =>
    root.render(
      <>
        <Reader />
        <Setter detail="Second" />
      </>,
    ),
  );
  expect(shown()).toBe("Second");
  await act(async () =>
    root.render(
      <>
        <Reader />
        <Setter detail={undefined} />
      </>,
    ),
  );
  expect(shown()).toBe("none");
});
