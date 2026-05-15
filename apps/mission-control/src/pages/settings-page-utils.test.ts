import { describe, expect, it, vi } from "vitest";
import {
  describeVoiceRuntimeReadiness,
  describeVoiceState,
  fileToBase64,
  formatDeploymentProfileLabel,
  formatTalkModeLabel,
  formatVoiceDate,
  formatVoiceLanguageScope,
} from "./settings-page-utils";

describe("settings-page-utils", () => {
  it("formats voice runtime states and readiness labels", () => {
    expect(describeVoiceState("running")).toBe("Runtime is currently active.");
    expect(describeVoiceState("error")).toBe("Runtime hit an error and needs attention.");
    expect(describeVoiceState("stopped")).toBe("Runtime is idle.");
    expect(describeVoiceState(undefined)).toBe("State unknown.");

    expect(describeVoiceRuntimeReadiness("ready")).toBe("Ready");
    expect(describeVoiceRuntimeReadiness("broken")).toBe("Installed but incomplete");
    expect(describeVoiceRuntimeReadiness("missing")).toBe("Missing");
    expect(describeVoiceRuntimeReadiness(undefined)).toBe("Unknown");
  });

  it("formats language scope, talk mode, dates, and deployment profiles", () => {
    expect(formatVoiceLanguageScope("english")).toBe("English");
    expect(formatVoiceLanguageScope("multilingual")).toBe("Multilingual");
    expect(formatTalkModeLabel("push_to_talk")).toBe("Push to talk");
    expect(formatTalkModeLabel("wake")).toBe("Wake triggered");
    expect(formatTalkModeLabel(undefined)).toBe("Not set");
    expect(formatVoiceDate()).toBe("-");
    expect(formatVoiceDate("not-a-date")).toBe("not-a-date");
    expect(formatVoiceDate("2026-05-14T12:00:00.000Z")).toContain("2026");
    expect(formatDeploymentProfileLabel("local_dev")).toBe("local_dev");
    expect(formatDeploymentProfileLabel("trusted_local")).toBe("trusted_local");
    expect(formatDeploymentProfileLabel("remote_hardened")).toBe("remote_hardened");
  });

  it("reads files as base64 payloads and rejects unreadable values", async () => {
    class DataUrlFileReader {
      result: string | ArrayBuffer | null = "data:audio/wav;base64,UklGRg==";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL = vi.fn(() => this.onload?.());
    }

    vi.stubGlobal("FileReader", DataUrlFileReader);
    await expect(fileToBase64(new File(["audio"], "clip.wav"))).resolves.toBe("UklGRg==");

    class RawFileReader {
      result: string | ArrayBuffer | null = "plain-base64";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL = vi.fn(() => this.onload?.());
    }

    vi.stubGlobal("FileReader", RawFileReader);
    await expect(fileToBase64(new File(["audio"], "clip.wav"))).resolves.toBe("plain-base64");

    class FailingFileReader {
      result: string | ArrayBuffer | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL = vi.fn(() => this.onerror?.());
    }

    vi.stubGlobal("FileReader", FailingFileReader);
    await expect(fileToBase64(new File(["audio"], "clip.wav"))).rejects.toThrow("Unable to read audio file.");
  });
});
