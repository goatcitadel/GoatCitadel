# Citadel Blueprint Schema (`goatcitadel.blueprint.v1`)

A **Blueprint** is a portable, inspectable, **secrets-free** description of a Citadel's
structure. It captures a Charter and Chambers only — never credentials, tokens,
private data, or identity (no `citadelId`, `chamberId`, or timestamps). Blueprints
let humans and external AI agents generate, share, review, and import Citadels safely.

This document describes the **v1** schema as implemented in
`packages/contracts/src/citadel-blueprints.ts` (`exportCitadelBlueprint`,
`validateCitadelBlueprint`, `applyCitadelBlueprint`).

## Top-level shape

```jsonc
{
  "schemaVersion": "goatcitadel.blueprint.v1",   // required, exact match
  "metadata": {
    "name": "Company Co-Founder",                 // required
    "description": "optional",                    // optional
    "exportedAt": "optional ISO-8601"             // optional
  },
  "charter": {                                    // required
    "purpose": "Run product, customers, growth…", // required, non-empty
    "kind": "company",                            // CitadelKind
    "goals": ["…"],
    "boundaries": ["Production writes require approval"],
    "successDefinition": ["A weekly business review"],
    "riskPosture": "conservative",                // CitadelRiskPosture
    "modelPolicyDefault": "hybrid_guarded"        // CitadelModelPolicy
  },
  "chambers": [                                   // required array
    { "name": "General", "sensitivity": "private", "sealed": false },
    { "name": "Finance", "sensitivity": "restricted", "sealed": true }
  ],
  "riskNotes": ["This Blueprint contains structure only — no secrets."]
}
```

## Enumerations

| Field | Allowed values |
|---|---|
| `charter.kind` (`CitadelKind`) | `personal`, `company`, `project`, `household`, `client`, `creator`, `learning`, `team`, `custom` |
| `charter.riskPosture` (`CitadelRiskPosture`) | `conservative`, `balanced`, `collaborative`, `automation_forward` |
| `charter.modelPolicyDefault` (`CitadelModelPolicy`) | `local_only`, `hybrid_guarded`, `approved_cloud`, `hosted_team` |
| `chambers[].sensitivity` (`ChamberSensitivity`) | `public`, `internal`, `private`, `sensitive`, `restricted`, `secret` |

## Validation rules (`validateCitadelBlueprint`)

A Blueprint is rejected (`{ ok: false, errors: [...] }`) when:

1. It is not an object.
2. `schemaVersion !== "goatcitadel.blueprint.v1"`.
3. `charter.purpose` is missing or empty.
4. `chambers` is not an array.
5. **It contains secret-shaped content.** The serialized Blueprint is scanned for
   patterns such as `sk-…` keys, PEM private-key headers, `api_key=/secret=/password=/token=`
   assignments, `Bearer <token>`, and `ghp_/gho_/…` GitHub tokens. **Blueprints must
   never carry secrets** — secrets belong only in the Gatehouse Secret Vault.

## Import flow

```
POST /api/v1/blueprints/validate            → { ok, errors }
POST /api/v1/citadels/:citadelId/from-blueprint  → validates, then upserts the
                                                   Charter and creates the Chambers,
                                                   returning the assembled Citadel.
```

Import **validates before applying**: an invalid or secret-bearing Blueprint is
rejected with `400` and no changes are made. Nothing is connected or activated by
import — integrations and high-risk Gates are always opened separately by the human.

## Export

```
GET /api/v1/citadels/:citadelId/blueprint
```

returns a v1 Blueprint built from the live Citadel, stripping all identity and
timestamps so the artifact is portable and contains structure only.

## Principles

- Human-readable and schema-validatable.
- Safe to inspect before import.
- Never contains secrets, OAuth/refresh tokens, API keys, or private files.
- Never silently activates live integrations or external writes.
- Carries `riskNotes` describing what it requests.
