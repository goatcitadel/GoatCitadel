import { expect, it } from "vitest";
import * as client from "./client.js";
import * as family0 from "./integrations.js";
import * as operations0 from "./integrations-operations.js";
import * as family1 from "./platform.js";
import * as operations1 from "./platform-operations.js";
import * as family2 from "./capabilities.js";
import * as operations2 from "./capabilities-operations.js";
import * as family3 from "./citadels.js";
import * as operations3 from "./citadels-operations.js";
import * as family4 from "./tasks.js";
import * as operations4 from "./tasks-operations.js";
import * as family5 from "./prompt-packs.js";
import * as operations5 from "./prompt-packs-operations.js";
import * as family6 from "./mcp.js";
import * as operations6 from "./mcp-operations.js";
import * as family7 from "./system.js";
import * as operations7 from "./system-operations.js";
import * as family8 from "./skills.js";
import * as operations8 from "./skills-operations.js";
import * as family9 from "./voice.js";
import * as operations9 from "./voice-operations.js";
import * as family10 from "./settings.js";
import * as operations10 from "./settings-operations.js";
import * as family11 from "./operators-agents-files.js";
import * as operations11 from "./operators-agents-files-operations.js";
import * as family12 from "./personal-ops.js";
import * as operations12 from "./personal-ops-operations.js";
import * as family13 from "./workspaces.js";
import * as operations13 from "./workspaces-operations.js";

it("retains canonical integrations operation bindings through existing public facades", () => {
  for (const name of Object.keys(operations0) as Array<keyof typeof operations0>) {
    expect(family0[name], name).toBe(operations0[name]);
    if (Object.prototype.hasOwnProperty.call(client, name))
      expect((client as Record<string, unknown>)[name], name).toBe(operations0[name]);
  }
});

it("retains canonical platform operation bindings through existing public facades", () => {
  for (const name of Object.keys(operations1) as Array<keyof typeof operations1>) {
    expect(family1[name], name).toBe(operations1[name]);
    if (Object.prototype.hasOwnProperty.call(client, name))
      expect((client as Record<string, unknown>)[name], name).toBe(operations1[name]);
  }
});

it("retains canonical capabilities operation bindings through existing public facades", () => {
  for (const name of Object.keys(operations2) as Array<keyof typeof operations2>) {
    expect(family2[name], name).toBe(operations2[name]);
    if (Object.prototype.hasOwnProperty.call(client, name))
      expect((client as Record<string, unknown>)[name], name).toBe(operations2[name]);
  }
});

it("retains canonical citadels operation bindings through existing public facades", () => {
  for (const name of Object.keys(operations3) as Array<keyof typeof operations3>) {
    expect(family3[name], name).toBe(operations3[name]);
    if (Object.prototype.hasOwnProperty.call(client, name))
      expect((client as Record<string, unknown>)[name], name).toBe(operations3[name]);
  }
});

it("retains canonical tasks operation bindings through existing public facades", () => {
  for (const name of Object.keys(operations4) as Array<keyof typeof operations4>) {
    expect(family4[name], name).toBe(operations4[name]);
    if (Object.prototype.hasOwnProperty.call(client, name))
      expect((client as Record<string, unknown>)[name], name).toBe(operations4[name]);
  }
});

it("retains canonical prompt-packs operation bindings through existing public facades", () => {
  for (const name of Object.keys(operations5) as Array<keyof typeof operations5>) {
    expect(family5[name], name).toBe(operations5[name]);
    if (Object.prototype.hasOwnProperty.call(client, name))
      expect((client as Record<string, unknown>)[name], name).toBe(operations5[name]);
  }
});

it("retains canonical mcp operation bindings through existing public facades", () => {
  for (const name of Object.keys(operations6) as Array<keyof typeof operations6>) {
    expect(family6[name], name).toBe(operations6[name]);
    if (Object.prototype.hasOwnProperty.call(client, name))
      expect((client as Record<string, unknown>)[name], name).toBe(operations6[name]);
  }
});

it("retains canonical system operation bindings through existing public facades", () => {
  for (const name of Object.keys(operations7) as Array<keyof typeof operations7>) {
    expect(family7[name], name).toBe(operations7[name]);
    if (Object.prototype.hasOwnProperty.call(client, name))
      expect((client as Record<string, unknown>)[name], name).toBe(operations7[name]);
  }
});

it("retains canonical skills operation bindings through existing public facades", () => {
  for (const name of Object.keys(operations8) as Array<keyof typeof operations8>) {
    expect(family8[name], name).toBe(operations8[name]);
    if (Object.prototype.hasOwnProperty.call(client, name))
      expect((client as Record<string, unknown>)[name], name).toBe(operations8[name]);
  }
});

it("retains canonical voice operation bindings through existing public facades", () => {
  for (const name of Object.keys(operations9) as Array<keyof typeof operations9>) {
    expect(family9[name], name).toBe(operations9[name]);
    if (Object.prototype.hasOwnProperty.call(client, name))
      expect((client as Record<string, unknown>)[name], name).toBe(operations9[name]);
  }
});

it("retains canonical settings operation bindings through existing public facades", () => {
  for (const name of Object.keys(operations10) as Array<keyof typeof operations10>) {
    expect(family10[name], name).toBe(operations10[name]);
    if (Object.prototype.hasOwnProperty.call(client, name))
      expect((client as Record<string, unknown>)[name], name).toBe(operations10[name]);
  }
});

it("retains canonical operators-agents-files operation bindings through existing public facades", () => {
  for (const name of Object.keys(operations11) as Array<keyof typeof operations11>) {
    expect(family11[name], name).toBe(operations11[name]);
    if (Object.prototype.hasOwnProperty.call(client, name))
      expect((client as Record<string, unknown>)[name], name).toBe(operations11[name]);
  }
});

it("retains canonical personal-ops operation bindings through existing public facades", () => {
  for (const name of Object.keys(operations12) as Array<keyof typeof operations12>) {
    expect(family12[name], name).toBe(operations12[name]);
    if (Object.prototype.hasOwnProperty.call(client, name))
      expect((client as Record<string, unknown>)[name], name).toBe(operations12[name]);
  }
});

it("retains canonical workspaces operation bindings through existing public facades", () => {
  for (const name of Object.keys(operations13) as Array<keyof typeof operations13>) {
    expect(family13[name], name).toBe(operations13[name]);
    if (Object.prototype.hasOwnProperty.call(client, name))
      expect((client as Record<string, unknown>)[name], name).toBe(operations13[name]);
  }
});
