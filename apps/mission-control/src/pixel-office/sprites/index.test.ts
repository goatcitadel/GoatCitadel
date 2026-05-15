import { describe, expect, it } from "vitest";
import { getCachedSprite, getCharacterSprites, getOutlineSprite } from "./index";
import * as spriteCache from "./spriteCache";
import * as spriteData from "./spriteData";

describe("pixel office sprite barrel", () => {
  it("re-exports the runtime sprite cache and character sprite helpers", () => {
    expect(getCachedSprite).toBe(spriteCache.getCachedSprite);
    expect(getOutlineSprite).toBe(spriteCache.getOutlineSprite);
    expect(getCharacterSprites).toBe(spriteData.getCharacterSprites);
  });
});
