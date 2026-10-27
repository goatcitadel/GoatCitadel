import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SAY_HI_POLL_MS,
  SETUP_CODE_ALPHABET,
  SETUP_CODE_LENGTH,
  SETUP_CODE_TTL_MS,
  createSetupCode,
} from "./setup-code";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createSetupCode", () => {
  it("makes ten characters from the letters and digits that are hard to mix up", () => {
    for (let index = 0; index < 50; index += 1) {
      expect(createSetupCode()).toMatch(/^[A-HJ-NP-Za-km-z2-9]{10}$/);
    }
    expect(SETUP_CODE_LENGTH).toBe(10);
  });

  it("never uses a character that looks like another", () => {
    for (const confusing of "0O1lI") expect(SETUP_CODE_ALPHABET).not.toContain(confusing);
    expect(new Set(SETUP_CODE_ALPHABET).size).toBe(SETUP_CODE_ALPHABET.length);
  });

  it("makes a different code every time", () => {
    const codes = new Set(Array.from({ length: 100 }, () => createSetupCode()));
    expect(codes.size).toBe(100);
  });

  it("draws from the browser's random source, not Math.random", () => {
    const math = vi.spyOn(Math, "random");
    const random = vi.spyOn(crypto, "getRandomValues");
    createSetupCode();
    expect(random).toHaveBeenCalled();
    expect(math).not.toHaveBeenCalled();
  });

  it("throws away random bytes that would make some characters likelier than others", () => {
    // 57 characters do not divide 256 evenly, so the last 28 byte values would favour the first 28 characters.
    const calls: number[] = [];
    vi.spyOn(crypto, "getRandomValues").mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
      const bytes = array as unknown as Uint8Array;
      // First draw: every byte is in the biased tail. Second draw: every byte is zero, the first character.
      bytes.fill(calls.length === 0 ? 255 : 0);
      calls.push(bytes.length);
      return array;
    });
    expect(createSetupCode()).toBe("A".repeat(10));
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("timing", () => {
  it("lets a code live ten minutes", () => {
    expect(SETUP_CODE_TTL_MS).toBe(600_000);
  });

  it("asks Telegram for the hi every 4 seconds, inside the 20 a minute the route allows", () => {
    expect(SAY_HI_POLL_MS).toBe(4_000);
    expect(60_000 / SAY_HI_POLL_MS).toBeLessThanOrEqual(20);
  });
});
