import { describe, expect, it } from "vitest";
import { buildTelegramTargetDirectory, resolveChannelTarget } from "./channel-target-directory.js";

describe("channel target directory", () => {
  it("merges Telegram config and discovered targets with display labels", () => {
    const directory = buildTelegramTargetDirectory({
      connectionId: "conn-1",
      now: new Date("2026-05-02T12:00:00.000Z"),
      connectionConfig: {
        targets: [{ label: "Ops Room", chatId: "-100123", default: true }],
        defaultChatId: "777",
      },
      discoveredTargets: [
        {
          id: "telegram:-100456",
          chatId: "-100456",
          label: "Deploy Room",
          kind: "supergroup",
          setupCodeMatched: true,
        },
      ],
    });

    expect(directory.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetId: "-100456",
          displayLabel: "Deploy Room",
          canonicalName: "deploy-room",
          source: "recent_update",
        }),
        expect.objectContaining({
          targetId: "777",
          displayLabel: "Telegram default",
          source: "connection_config",
        }),
        expect.objectContaining({
          targetId: "-100123",
          displayLabel: "Ops Room",
          canonicalName: "ops-room",
        }),
      ]),
    );
  });

  it("resolves exact, prefixed, and ambiguous target names", () => {
    const directory = buildTelegramTargetDirectory({
      connectionId: "conn-1",
      connectionConfig: {
        targets: [
          { label: "Ops Room", chatId: "-100123" },
          { label: "Ops Review", chatId: "-100456" },
        ],
      },
    });

    expect(resolveChannelTarget(directory, "telegram:Ops Room")).toEqual(
      expect.objectContaining({ status: "resolved", entry: expect.objectContaining({ targetId: "-100123" }) }),
    );
    expect(resolveChannelTarget(directory, "Ops")).toEqual(expect.objectContaining({ status: "ambiguous" }));
    expect(resolveChannelTarget(directory, "missing")).toEqual(expect.objectContaining({ status: "not_found" }));
  });
});
