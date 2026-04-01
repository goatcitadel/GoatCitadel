# Voice Validation Checklist

Last updated: 2026-03-30
Scope: `GC-P2-12` Voice Wake / Talk Mode parity

## Purpose

This is the operator-proof lane for GoatCitadel's current local-first voice surface.

Use it to validate the runtime as a real operator workflow instead of treating voice as a background implementation detail.

## Preconditions

1. Generate the current voice proof-lane draft from Mission Control System to capture live runtime readiness, selected model, and current talk/wake state.
2. Confirm a managed local model is selected.
3. Confirm the runtime is `ready` before attempting wake or talk validation.

## Proof Path

1. Capture runtime posture
   - Record runtime readiness.
   - Record selected model id.
   - Record current talk state and wake state.

2. Run a one-shot transcription
   - Use a local sample file.
   - Confirm a transcript returns without missing-runtime or missing-model failure.
   - Record transcript quality issues separately from runtime failures.

3. Run a Talk Mode cycle
   - Start a talk session.
   - Confirm the running state is visible in Settings or System.
   - Stop the session cleanly.
   - Record session ids and any operator-facing errors.

4. Run a Wake Mode cycle
   - Enable wake.
   - Confirm the enabled/running state becomes visible.
   - Disable wake again.
   - Record readiness/model issues if wake cannot start cleanly.

5. Record failure recovery
   - If runtime readiness fails, document the exact recovery step.
   - If a selected model is missing, document the operator-visible recovery path.
   - If a talk session is already running, record the stop/restart path.

6. Complete the proof bundle
   - Fill `templates/verification/voice-proof-bundle.md`.
   - Keep transcript output, state transitions, and recovery notes together.

## Evidence Bundle Minimum

- Runtime readiness snapshot
- Selected model id
- One transcription output
- One talk start/stop cycle
- One wake enable/disable cycle
- Any recovery or repair steps taken

## Not Proven By This Checklist

- Cloud voice parity
- Mobile wake parity
- Full conversational agent behavior over voice
- Production-grade acoustic accuracy benchmarking
