import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeVoiceRuntimeReadiness,
  describeVoiceState,
  fileToBase64,
  formatDeploymentProfileLabel,
  formatTalkModeLabel,
  formatVoiceDate,
  formatVoiceLanguageScope,
} from "./settings-page-utils";

const originalFileReader = globalThis.FileReader;

afterEach(() => {
  globalThis.FileReader = originalFileReader;
  vi.restoreAllMocks();
});

class SuccessfulFileReader {
  public result: string | ArrayBuffer | null = null;
  public onload: (() => void) | null = null;
  public onerror: (() => void) | null = null;

  public readAsDataURL(_file: File): void {
    this.result = "data:audio/wav;base64,UklGRg==";
    this.onload?.();
  }
}

describe("settings-page-utils", () => {
  it("formats voice runtime state and readiness labels", () => {
    expect(describeVoiceState("running")).toBe("Runtime is currently active.");
    expect(describeVoiceState("error")).toBe("Runtime hit an error and needs attention.");
    expect(describeVoiceState("stopped")).toBe("Runtime is idle.");
    expect(describeVoiceState(undefined)).toBe("State unknown.");

    expect(describeVoiceRuntimeReadiness("ready")).toBe("Ready");
    expect(describeVoiceRuntimeReadiness("broken")).toBe("Installed but incomplete");
    expect(describeVoiceRuntimeReadiness("missing")).toBe("Missing");
    expect(describeVoiceRuntimeReadiness(undefined)).toBe("Unknown");

    expect(formatVoiceLanguageScope("english")).toBe("English");
    expect(formatVoiceLanguageScope("multilingual")).toBe("Multilingual");
    expect(formatTalkModeLabel("push_to_talk")).toBe("Push to talk");
    expect(formatTalkModeLabel("wake")).toBe("Wake triggered");
    expect(formatTalkModeLabel(undefined)).toBe("Not set");
  });

  it("formats deployment profiles and dates defensively", () => {
    expect(formatDeploymentProfileLabel("local_dev")).toBe("local_dev");
    expect(formatDeploymentProfileLabel("trusted_local")).toBe("trusted_local");
    expect(formatDeploymentProfileLabel("remote_hardened")).toBe("remote_hardened");
    expect(formatVoiceDate(undefined)).toBe("-");
    expect(formatVoiceDate("not-a-date")).toBe("not-a-date");
    expect(formatVoiceDate("2026-05-04T12:00:00.000Z")).not.toBe("2026-05-04T12:00:00.000Z");
  });

  it("converts files to base64 and reports FileReader failures", async () => {
    globalThis.FileReader = SuccessfulFileReader as never;
    await expect(fileToBase64({} as File)).resolves.toBe("UklGRg==");

    class StringWithoutPrefixFileReader extends SuccessfulFileReader {
      public override readAsDataURL(_file: File): void {
        this.result = "raw-base64";
        this.onload?.();
      }
    }
    globalThis.FileReader = StringWithoutPrefixFileReader as never;
    await expect(fileToBase64({} as File)).resolves.toBe("raw-base64");

    class NonStringFileReader extends SuccessfulFileReader {
      public override readAsDataURL(_file: File): void {
        this.result = new ArrayBuffer(0);
        this.onload?.();
      }
    }
    globalThis.FileReader = NonStringFileReader as never;
    await expect(fileToBase64({} as File)).rejects.toThrow("Unable to read audio file.");

    class ErrorFileReader extends SuccessfulFileReader {
      public override readAsDataURL(_file: File): void {
        this.onerror?.();
      }
    }
    globalThis.FileReader = ErrorFileReader as never;
    await expect(fileToBase64({} as File)).rejects.toThrow("Unable to read audio file.");
  });
});
