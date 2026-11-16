// @vitest-environment happy-dom
import { beforeEach, expect, it } from "vitest";
import { readInspectorWidth, writeInspectorWidth } from "./inspector-width-preference";

beforeEach(() => window.localStorage.clear());

it("remembers the width per area (U-GL-030)", () => {
  writeInspectorWidth("work", 520);
  expect(readInspectorWidth("work")).toBe(520);
  expect(readInspectorWidth("chat")).toBe(384);
});

it("clamps to the allowed range and survives bad storage", () => {
  writeInspectorWidth("work", 900);
  expect(readInspectorWidth("work")).toBe(560);
  window.localStorage.setItem("goatcitadel.cockpit.inspector.width.v1", "{not json");
  expect(readInspectorWidth("work")).toBe(384);
});

it("ignores a stored value outside the range", () => {
  window.localStorage.setItem("goatcitadel.cockpit.inspector.width.v1", JSON.stringify({ work: 99999, chat: "wide" }));
  expect(readInspectorWidth("work")).toBe(384);
  expect(readInspectorWidth("chat")).toBe(384);
});

it("keeps working when storage throws on read and on write", () => {
  const original = Object.getOwnPropertyDescriptor(window, "localStorage")!;
  const denied = () => {
    throw new Error("denied");
  };
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: { getItem: denied, setItem: denied },
  });
  try {
    expect(readInspectorWidth("work")).toBe(384);
    expect(() => writeInspectorWidth("work", 500)).not.toThrow();
  } finally {
    Object.defineProperty(window, "localStorage", original);
  }
});
