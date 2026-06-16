---
name: citadel-mason
description: Use when a user wants to create, customize, export, import, or review a GoatCitadel Citadel Blueprint. Produces safe, schema-valid `goatcitadel.blueprint.v1` Blueprints for protected AI operating spaces.
---

# Citadel Mason Skill

The Mason helps design **Citadels** — protected AI operating spaces — by producing
safe, reviewable **Blueprints**. A Blueprint is portable structure only: a Charter
and Chambers. It never contains secrets, credentials, tokens, private data, or
live authorization.

See `docs/citadel-blueprint-schema.md` for the full `goatcitadel.blueprint.v1` schema.

## When to use

The user wants to create, customize, export, import, or review a Citadel Blueprint —
or set up a new Citadel for a part of their life or work.

## Core rules (non-negotiable)

1. **Never** include secrets, API keys, OAuth/refresh tokens, private files, or credentials.
2. **Never** enable external write actions by default. Propose permissions; do not assume them.
3. Use **Chambers** for sensitive areas; mark them `sealed: true` with a `restricted`/`sensitive`/`secret` sensitivity.
4. Use conservative Gatehouse defaults (`riskPosture: "conservative"` for company/finance/legal contexts).
5. Output a **schema-valid** `goatcitadel.blueprint.v1` (see schema doc) — it must pass `validateCitadelBlueprint`.
6. Always include a human-readable **review summary** and `riskNotes`.
7. A Blueprint is **staged configuration, not live activation.** Only the human opens Gates.

## Workflow

1. Ask what the Citadel is for, and pick the `kind` (`personal`/`company`/`project`/…).
2. Ask what is sensitive → those become `sealed` Chambers.
3. Ask what success looks like → `charter.successDefinition`.
4. Ask what must always require approval / never happen → `charter.boundaries`.
5. Draft the Charter (`purpose`, `goals`, `boundaries`, `successDefinition`, `riskPosture`, `modelPolicyDefault`).
6. Propose Chambers (General + domain Chambers; sensitive ones sealed).
7. Produce the Blueprint and a review summary with risks and assumptions.

## Output

Return:

- a human-readable summary (what this Citadel can see/remember/do, what is sealed),
- risks and assumptions + `riskNotes`,
- a valid `citadel.blueprint.yaml` / JSON.

### Example (JSON, passes validation)

```json
{
  "schemaVersion": "goatcitadel.blueprint.v1",
  "metadata": { "name": "Company Co-Founder" },
  "charter": {
    "purpose": "Help a founder run product, customers, growth, finance, and operations.",
    "kind": "company",
    "goals": ["Maintain a current operating picture", "Support a weekly business review"],
    "boundaries": ["Production writes require approval", "External emails draft-only by default"],
    "successDefinition": ["A useful daily founder brief", "A completed weekly business review"],
    "riskPosture": "conservative",
    "modelPolicyDefault": "hybrid_guarded"
  },
  "chambers": [
    { "name": "General", "sensitivity": "private", "sealed": false },
    { "name": "Product", "sensitivity": "private", "sealed": false },
    { "name": "Finance", "sensitivity": "restricted", "sealed": true },
    { "name": "Legal", "sensitivity": "restricted", "sealed": true }
  ],
  "riskNotes": ["This Blueprint contains structure only — no credentials or secrets."]
}
```

## Safe tools for external agents

- `POST /api/v1/blueprints/validate` — validate a Blueprint (schema + no-secrets scan) before proposing it.
- `POST /api/v1/citadels/:citadelId/from-blueprint` — stage a Citadel from a validated Blueprint (validates again; rejects secrets).
- `GET /api/v1/citadel-templates` — list official starter templates to adapt.

Do **not** attempt to connect accounts, enable write tools, invite members, or
create live automations — those are human-only Gatehouse actions.
