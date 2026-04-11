import type { IntegrationCatalogEntry, IntegrationFieldSchema, IntegrationFormSchema, IntegrationOperatorAction } from "@goatcitadel/contracts";

const LOCAL_BRIDGE_CATALOG_IDS = new Set([
  "productivity.apple-notes",
  "productivity.apple-reminders",
  "productivity.things3",
  "productivity.bear",
  "automation.peekaboo-screen",
  "automation.camera-photo-video",
  "platform.macos-menubar-voice",
  "platform.ios-canvas-camera-voice",
]);

const OPERATOR_ACTIONS_BY_CATALOG_ID: Record<string, IntegrationOperatorAction[]> = {
  "productivity.apple-notes": [
    action("read", "Read Sample", "Fetch a small sample payload from the configured Apple Notes bridge.", "read"),
    action(
      "write",
      "Write Sample",
      "Send a sample note payload to the configured Apple Notes bridge.",
      "write",
      formSchema("action:productivity.apple-notes.write", "Write sample note", [
        text("title", "Title", { placeholder: "GoatCitadel operator note", defaultValue: "GoatCitadel operator note" }),
        textarea("content", "Content", {
          placeholder: "This is a GoatCitadel operator write check.",
          defaultValue: "This is a GoatCitadel operator write check.",
          required: true,
        }),
      ]),
    ),
  ],
  "productivity.apple-reminders": [
    action("read", "Read Sample", "Fetch reminder/list metadata from the configured Apple Reminders bridge.", "read"),
    action(
      "write",
      "Create Reminder",
      "Create a sample reminder through the configured Apple Reminders bridge.",
      "write",
      formSchema("action:productivity.apple-reminders.write", "Create sample reminder", [
        text("title", "Title", { placeholder: "GoatCitadel follow-up", defaultValue: "GoatCitadel follow-up", required: true }),
        text("notes", "Notes", { placeholder: "Created from Mission Control operator actions." }),
      ]),
    ),
  ],
  "productivity.things3": [
    action("read", "Read Sample", "Fetch Things 3 task/list metadata from the configured bridge.", "read"),
    action(
      "write",
      "Create Task",
      "Create a sample Things 3 task through the configured bridge.",
      "write",
      formSchema("action:productivity.things3.write", "Create sample task", [
        text("title", "Title", { placeholder: "GoatCitadel task", defaultValue: "GoatCitadel task", required: true }),
        text("notes", "Notes", { placeholder: "Created from Mission Control operator actions." }),
      ]),
    ),
  ],
  "productivity.bear": [
    action("read", "Read Sample", "Fetch Bear note metadata from the configured bridge.", "read"),
    action(
      "write",
      "Write Sample",
      "Send a sample note payload to the configured Bear bridge.",
      "write",
      formSchema("action:productivity.bear.write", "Write sample Bear note", [
        text("title", "Title", { placeholder: "GoatCitadel Bear note", defaultValue: "GoatCitadel Bear note" }),
        textarea("content", "Content", {
          placeholder: "This is a GoatCitadel Bear write check.",
          defaultValue: "This is a GoatCitadel Bear write check.",
          required: true,
        }),
      ]),
    ),
  ],
  "productivity.trello": [
    action("read", "List Boards", "List a small sample of readable Trello boards for the configured token.", "read"),
    action(
      "write",
      "Create Card",
      "Create a sample Trello card in the configured default list.",
      "write",
      formSchema("action:productivity.trello.write", "Create sample Trello card", [
        text("name", "Card Name", { placeholder: "GoatCitadel operator card", defaultValue: "GoatCitadel operator card", required: true }),
        textarea("desc", "Description", { placeholder: "Created from Mission Control operator actions." }),
        text("listId", "List ID Override", { placeholder: "Optional override if defaultListId is not set", advanced: true }),
      ]),
    ),
  ],
  "automation.gif-search": [
    action(
      "search",
      "Search GIFs",
      "Run a live GIF search against the configured provider and preview the first results.",
      "search",
      formSchema("action:automation.gif-search.search", "Search GIFs", [
        text("query", "Query", { placeholder: "happy goat", defaultValue: "happy goat", required: true }),
      ]),
    ),
  ],
  "automation.peekaboo-screen": [
    action("capture", "Capture Preview", "Request a sample capture from the configured screen bridge.", "capture"),
    action(
      "control",
      "Control Ping",
      "Send a lightweight control/ping action to the configured screen bridge.",
      "control",
      formSchema("action:automation.peekaboo-screen.control", "Control bridge", [
        text("command", "Command", { placeholder: "ping", defaultValue: "ping", required: true }),
      ]),
    ),
  ],
  "automation.camera-photo-video": [
    action("capture", "Capture Preview", "Request a sample photo/video capture from the configured camera bridge.", "capture"),
  ],
  "platform.macos-menubar-voice": [
    action(
      "voice",
      "Voice Ping",
      "Send a lightweight voice-path check to the configured macOS companion bridge.",
      "voice",
      formSchema("action:platform.macos-menubar-voice.voice", "Voice check", [
        text("prompt", "Prompt", { placeholder: "Operator voice check", defaultValue: "Operator voice check", required: true }),
      ]),
    ),
    action("tray", "Tray Status", "Request current tray/runtime status from the configured macOS companion bridge.", "tray"),
  ],
  "platform.ios-canvas-camera-voice": [
    action(
      "canvas",
      "Canvas Check",
      "Send a lightweight canvas message to the configured iOS companion bridge.",
      "canvas",
      formSchema("action:platform.ios-canvas-camera-voice.canvas", "Canvas check", [
        text("content", "Content", { placeholder: "Operator canvas check", defaultValue: "Operator canvas check", required: true }),
      ]),
    ),
    action("camera", "Camera Check", "Request a sample camera capability check from the configured iOS companion bridge.", "camera"),
    action(
      "voice",
      "Voice Check",
      "Send a lightweight voice-path check to the configured iOS companion bridge.",
      "voice",
      formSchema("action:platform.ios-canvas-camera-voice.voice", "Voice check", [
        text("prompt", "Prompt", { placeholder: "Operator voice check", defaultValue: "Operator voice check", required: true }),
      ]),
    ),
  ],
};

export function getIntegrationOperatorActions(catalogId: string): IntegrationOperatorAction[] {
  return OPERATOR_ACTIONS_BY_CATALOG_ID[catalogId] ? [...OPERATOR_ACTIONS_BY_CATALOG_ID[catalogId]] : [];
}

export function getCatalogCapabilitiesFromOperatorActions(
  catalogId: string,
  fallbackCapabilities: string[],
): string[] {
  const actions = getIntegrationOperatorActions(catalogId);
  if (actions.length === 0) {
    return fallbackCapabilities;
  }
  return [...new Set(actions.map((action) => action.capability))];
}

export function hasIntegrationOperatorAction(catalogId: string, actionId: string): boolean {
  return getIntegrationOperatorActions(catalogId).some((action) => action.actionId === actionId);
}

export function isLocalBridgeCatalogId(catalogId: string): boolean {
  return LOCAL_BRIDGE_CATALOG_IDS.has(catalogId);
}

function action(
  actionId: string,
  label: string,
  description: string,
  capability: string,
  form?: IntegrationFormSchema,
): IntegrationOperatorAction {
  return {
    actionId,
    label,
    description,
    capability,
    formSchema: form,
  };
}

function formSchema(catalogId: string, title: string, fields: IntegrationFieldSchema[]): IntegrationFormSchema {
  return {
    catalogId,
    title,
    allowAdvancedJson: false,
    fields,
  };
}

function text(
  key: string,
  label: string,
  options: Partial<IntegrationFieldSchema> = {},
): IntegrationFieldSchema {
  return { key, label, type: "text", ...options };
}

function textarea(
  key: string,
  label: string,
  options: Partial<IntegrationFieldSchema> = {},
): IntegrationFieldSchema {
  return { key, label, type: "textarea", ...options };
}

export function entryWithOperatorActions(
  entry: IntegrationCatalogEntry,
): IntegrationCatalogEntry {
  const operatorActions = getIntegrationOperatorActions(entry.catalogId);
  if (operatorActions.length === 0) {
    return entry;
  }
  return {
    ...entry,
    capabilities: getCatalogCapabilitiesFromOperatorActions(entry.catalogId, entry.capabilities),
    operatorActions,
  };
}
