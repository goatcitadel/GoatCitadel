import { PLUGIN_MANIFEST_REFUSAL_CODES } from "@goatcitadel/contracts";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { describe, expect, it } from "vitest";
import {
  CANT_BE_INSTALLED,
  manifestRefusalLines,
  PLUGIN_REFUSAL_COPY,
  pluginRefusalOf,
  refusalMessage,
} from "./plugin-check-copy";
import {
  SIGNING_SECRET_HINT,
  SKIP_ON_NEXT,
  UNVERIFIED_WARNING,
  checkLine,
  skipOffNext,
  sourceLine,
} from "./plugin-install-view";

/** The copy guard's own rules, read from the script, so a value an operator reads is held to the same words. */
async function copyRatchets(): Promise<Array<{ id: string; pattern?: RegExp }>> {
  const guard = new URL("../../../../../../../scripts/check-mission-control-next-cockpit-copy.mjs", import.meta.url);
  const module = (await import(/* @vite-ignore */ guard.href)) as {
    COPY_RATCHETS: Array<{ id: string; pattern?: RegExp }>;
  };
  return module.COPY_RATCHETS;
}

function refused(status: number, body: unknown, kind: "http" | "network" = "http") {
  return new ApiRequestError("refused", {
    kind,
    method: "POST",
    path: "/api/v1/capabilities/plugins/inspections",
    ...(kind === "http" ? { status } : {}),
    body,
  });
}

describe("plugin check copy", () => {
  it("has plain words for every code a refused manifest can carry", () => {
    for (const code of PLUGIN_MANIFEST_REFUSAL_CODES) {
      expect(PLUGIN_REFUSAL_COPY[code], code).toMatch(/^[A-Z].*\.$/u);
      expect(manifestRefusalLines(code, "The refusal's own words.")).toEqual([
        PLUGIN_REFUSAL_COPY[code],
        CANT_BE_INSTALLED,
      ]);
    }
    expect(Object.keys(PLUGIN_REFUSAL_COPY).sort()).toEqual([...PLUGIN_MANIFEST_REFUSAL_CODES].sort());
    // The plan's own lines, word for word.
    expect(PLUGIN_REFUSAL_COPY.FEATURE_FLAGS_NOT_ALLOWED).toBe("Plugins can't change GoatCitadel's feature settings.");
    expect(PLUGIN_REFUSAL_COPY.HOOK_MUST_ONLY_OBSERVE).toBe(
      "Its hooks try to change what happens, but plugin hooks can only watch.",
    );
    expect(PLUGIN_REFUSAL_COPY.MANIFEST_MISSING).toBe(
      "There's no goatcitadel-plugin.json or .claude-plugin/plugin.json at its top level.",
    );
    expect(PLUGIN_REFUSAL_COPY.CLAUDE_CODE_MANIFEST_INVALID).toBe(
      "Its .claude-plugin/plugin.json isn't one GoatCitadel can read.",
    );
    expect(PLUGIN_REFUSAL_COPY.NOTHING_TO_INSTALL).toBe("GoatCitadel can't use any of its parts.");
    expect(PLUGIN_REFUSAL_COPY.TOO_MANY_PIECES).toBe(
      "It has more parts GoatCitadel could take than one plugin can hold.",
    );
  });

  it("keeps the refusal's own sentence for a code it has no words for, and still says it can't be installed", () => {
    expect(
      manifestRefusalLines("SOMETHING_NEW", "This built-in plugin's manifest names a different plugin id."),
    ).toEqual(["This built-in plugin's manifest names a different plugin id.", CANT_BE_INSTALLED]);
    // A code that only looks like one of the map's keys is not one.
    expect(manifestRefusalLines("toString", "Own words.")[0]).toBe("Own words.");
  });

  it("uses none of the words the copy guard keeps out of the cockpit", async () => {
    const rules = (await copyRatchets()).filter((rule) => rule.pattern);
    expect(rules.map((rule) => rule.id)).toEqual(expect.arrayContaining(["internal-terms", "glossary-terms"]));
    const values = [
      ...Object.values(PLUGIN_REFUSAL_COPY),
      CANT_BE_INSTALLED,
      UNVERIFIED_WARNING,
      SIGNING_SECRET_HINT,
      SKIP_ON_NEXT,
      skipOffNext(0),
      skipOffNext(1),
      skipOffNext(3),
      checkLine({ status: "ready" }, "skill"),
      checkLine({ status: "already_there" }, "connector"),
      checkLine({ status: "already_there" }, "tool_group_off"),
      sourceLine({
        sourceKind: "built_in",
        sourceDisplay: "Ships with GoatCitadel",
        pin: { kind: "content", treeSha256: "a" },
      }),
      sourceLine({ sourceKind: "folder", sourceDisplay: "tools", pin: { kind: "content", treeSha256: "a" } }),
    ];
    for (const value of values) {
      for (const rule of rules) {
        const pattern = new RegExp(rule.pattern!.source, rule.pattern!.flags);
        expect(value.match(pattern), `${rule.id}: ${value}`).toBeNull();
      }
    }
  });

  it("reads a refusal's own plain sentence first, and the plain summary only without one", () => {
    // describeApiError would say "That item no longer exists." for this 404; the route's own words are plainer.
    const notFound = refused(404, { error: "That folder doesn't exist on this computer.", code: "PLUGIN_REFUSED" });
    expect(refusalMessage(notFound)).toBe("That folder doesn't exist on this computer.");
    expect(refusalMessage(refused(409, { error: "  " }))).toBe(describeApiError(refused(409, { error: "  " })).summary);
    const offline = refused(0, undefined, "network");
    expect(refusalMessage(offline)).toBe(describeApiError(offline).summary);
  });

  it("reads why a source or manifest was refused, and the inspection a refused manifest kept", () => {
    expect(
      pluginRefusalOf(
        refused(422, {
          error: "Its hooks would run code.",
          code: "PLUGIN_REFUSED",
          details: { code: "HOOK_CODE_NOT_ALLOWED", inspectionId: "insp-9", field: "pieces[1].mode" },
        }),
      ),
    ).toEqual({ code: "HOOK_CODE_NOT_ALLOWED", inspectionId: "insp-9", field: "pieces[1].mode" });
    expect(
      pluginRefusalOf(
        refused(400, { error: "Not https.", code: "PLUGIN_REFUSED", details: { code: "INVALID_GIT_SOURCE" } }),
      ),
    ).toEqual({ code: "INVALID_GIT_SOURCE" });
    // Any other refusal isn't a plugin check's own.
    expect(pluginRefusalOf(refused(409, { error: "Taken.", code: "ALREADY_EXISTS" }))).toBeUndefined();
    expect(pluginRefusalOf(new Error("offline"))).toBeUndefined();
  });
});

describe("plugin install words", () => {
  it("names the source as the plan does, with the pin's first 7 characters", () => {
    expect(
      sourceLine({
        sourceKind: "git",
        sourceDisplay: "github.com/acme/tools",
        pin: { kind: "commit", commit: "0123456789abcdef0123456789abcdef01234567" },
      }),
    ).toBe("Git repository github.com/acme/tools, pinned to commit 0123456");
    expect(
      sourceLine({
        sourceKind: "built_in",
        sourceDisplay: "Ships with GoatCitadel",
        pin: { kind: "content", treeSha256: "a" },
      }),
    ).toBe("Ships with GoatCitadel");
    expect(
      sourceLine({ sourceKind: "folder", sourceDisplay: "tools", pin: { kind: "content", treeSha256: "a" } }),
    ).toBe("Folder on this computer");
  });

  it("counts the approvals with the setting off: once for the plugin, twice for each skill", () => {
    expect(skipOffNext(0)).toBe("Asks you once, for the plugin.");
    expect(skipOffNext(1)).toBe("Asks you 3 times: once for the plugin and twice for its skill.");
    expect(skipOffNext(2)).toBe("Asks you 5 times: once for the plugin and twice for each skill.");
  });

  it("words each check, a kept group as off rather than installed", () => {
    expect(checkLine({ status: "ready" }, "connector")).toBe("Passed GoatCitadel's checks");
    expect(checkLine({ status: "already_there" }, "connector")).toBe("Already installed. Stays when you uninstall.");
    expect(checkLine({ status: "already_there" }, "tool_group_off")).toBe("Stays off when you uninstall.");
    expect(
      checkLine({ status: "blocked", code: "HOST_NOT_PUBLIC", message: "That address isn't a public host." }, "hook"),
    ).toBe("That address isn't a public host.");
  });
});
