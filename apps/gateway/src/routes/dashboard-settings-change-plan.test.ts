import { describe, expect, it } from "vitest";
import {
  PUBLIC_WEB_ADDRESS_HAS_EXTRA,
  PUBLIC_WEB_ADDRESS_NOT_HTTPS,
  PUBLIC_WEB_ADDRESS_NOT_PUBLIC,
  PUBLIC_WEB_ADDRESS_NOT_URL,
  PUBLIC_WEB_ADDRESS_TOO_LONG,
  ValidationError,
} from "@goatcitadel/contracts";
import { settingsChangePlanRequest } from "./dashboard-settings-change-plan.js";

describe("settingsChangePlanRequest public web address", () => {
  it("maps a save to its own governed operation with the address tidied", () => {
    expect(settingsChangePlanRequest({ expectedRevision: 7, publicWebAddress: "https://Example.com/" })).toEqual({
      kind: "runtime_configuration",
      change: { operation: "public_web_address_configuration", config: { publicWebAddress: "https://example.com" } },
    });
    expect(
      settingsChangePlanRequest({ expectedRevision: 7, publicWebAddress: "  https://goat.example.com:8443/a/ " }),
    ).toEqual({
      kind: "runtime_configuration",
      change: {
        operation: "public_web_address_configuration",
        config: { publicWebAddress: "https://goat.example.com:8443/a" },
      },
    });
  });

  it("maps null to a clear", () => {
    expect(settingsChangePlanRequest({ expectedRevision: 7, publicWebAddress: null })).toEqual({
      kind: "runtime_configuration",
      change: { operation: "public_web_address_configuration", config: { publicWebAddress: null } },
    });
  });

  it.each([
    ["example.com", PUBLIC_WEB_ADDRESS_NOT_URL],
    ["http://example.com", PUBLIC_WEB_ADDRESS_NOT_HTTPS],
    ["https://example.com/#x", PUBLIC_WEB_ADDRESS_HAS_EXTRA],
    ["https://192.168.1.5", PUBLIC_WEB_ADDRESS_NOT_PUBLIC],
    ["https://" + "a".repeat(200) + ".com", PUBLIC_WEB_ADDRESS_TOO_LONG],
  ])("refuses %s with its sentence, as a 400 the route sends", (address, sentence) => {
    let error: unknown;
    try {
      settingsChangePlanRequest({ expectedRevision: 7, publicWebAddress: address });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).message).toBe(sentence);
    expect((error as ValidationError).httpStatus).toBe(400);
  });

  it("refuses the address together with another settings key, as every two-key save is refused", () => {
    expect(
      settingsChangePlanRequest({ expectedRevision: 7, publicWebAddress: "https://example.com", budgetMode: "saver" }),
    ).toBeNull();
    expect(
      settingsChangePlanRequest({
        expectedRevision: 7,
        publicWebAddress: null,
        web: { firecrawl: { enabled: true } },
      }),
    ).toBeNull();
  });

  it("makes no plan when the key is present with nothing in it", () => {
    expect(settingsChangePlanRequest({ expectedRevision: 7, publicWebAddress: undefined })).toBeNull();
  });
});
