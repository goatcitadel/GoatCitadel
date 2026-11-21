# First-run Cockpit tutorial

Date 2026-11-19

Proposed design for approval

## Intent

Give a new GoatCitadel user a short, optional exercise immediately after choosing a model. By the end, the user can send a message, read and decide a tool request, find the task and its output, and recognize where to go for the rest of the app. The revised interactive preview is the visual and interaction baseline.

## Approaches considered

| Approach | Tradeoff |
|---|---|
| Temporary practice session in the real Cockpit | Uses the same views and controls the user will see after setup. A scripted scenario gives a predictable outcome and keeps cleanup local to the session. The tour needs a bounded source of sample reads and actions. |
| Disposable workspace in the live Gateway | Exercises normal backend workflows with real records. The lifecycle would need to manage linked conversations, approvals, runs, tasks, outputs, and retained evidence across several owners. |

The operator chose the **temporary practice session** and approved the revised preview as the basis for the design. The scope is the first-run Cockpit flow and its eight top-level areas. Secondary tabs are introduced by name where they help the user find something later.

## Setup and handoff

1. When the existing model step confirms a ready default model, offer **Take the tutorial** and **Skip tutorial** in the wizard. Explain that the tutorial uses temporary examples that clear when the user finishes or exits.
2. Both choices continue to the existing safety review. The normal model readiness, approval-rule review, and setup completion checks still govern the transition. Revisiting the model step before completion allows the user to change their tutorial choice.
3. On successful setup completion, **Skip tutorial** takes the existing route to Chat. **Take the tutorial** opens the practice session. Setup completion is the existing Gateway-owned operation. Existing completed installations open through their usual routes.
4. **Finish tutorial** and **Exit tutorial** both return to the usual Chat landing for the original Citadel and workspace. A short status message confirms that the practice data was cleared. Skip follows the usual landing without a tutorial message. The first real completed Chat answer remains the proof that the configured model works.

The choice is scoped to the setup in progress. Exiting setup before completion or switching installation discards it. Start the tour only after the opted-in wizard confirms completion of its current setup attempt. If setup has already completed elsewhere, the recorded state takes the usual path to Chat. If the tour fails to start after setup completes, offer **Try again** and **Open Chat** from a recoverable state.

## The exercise

The example is a team offsite checklist. Start with the prefilled prompt **Use the offsite planning guide to draft a checklist for our team.** The user sends it with the normal **Send** control. The practice assistant asks to search example documents using the same read-only *Docs search* request users see in GoatCitadel. The pending request appears in Chat and Inbox and represents a single simulated decision.

| Stop | What the guide asks the user to do or look for |
|---|---|
| **Chat** | Press **Send**. Explain that Chat is where users ask questions and start work. After the sample reply, point out the inline request, explain why the assistant paused, and use **Next** to show the same request in Inbox. |
| **Inbox** | Choose **Review request** and read what the search would access. Show **Approve once**, **Deny**, and **Allow this tool in this Chat** in the real review panel. After a decision, explain what the assistant did and point to Work. If the user already decided in Chat, explain where the decision went and let them continue. |
| **Work** | Open **Plan a team offsite** on **Board** to inspect its status. An approved search leaves the sample task **Done**. A denied search leaves it **Blocked**. The card explains that users can return here to find tasks and runs from their conversations. |
| **Library** | Open **Artifacts** and choose **Inspect** on the checklist. Explain how to read the output and find its source conversation. After denial, offer **Example offsite checklist** as a separately labeled teaching sample. Ask the user to close the artifact preview to continue. |
| **Capabilities** | On **Tools**, point out document search under **Memory and knowledge**. Introduce **Connectors** for services, **Skills** for repeatable workflows, and **Plugins** for bundles. |
| **Scripts** | Show where scripts and saved files appear with their source runs. Explain that the practice checklist is an artifact under Library. |
| **System** | Start at **Health**. Point to **Activity** for what happened, **Diagnostics** for errors, and **Spend** for usage and cost. Statuses shown during the exercise are labeled as examples. |
| **Settings** | Point to **Models** for the provider and default model and to **Safety** for approval rules. **Finish tutorial** clears the practice data and opens Chat. |

**Approve once** permits only the simulated search. It produces a sample reply based on the practice guide and saves the scripted checklist in the temporary Artifacts view. **Deny** prevents the search and leaves a blocked task. The teaching sample in the denial path is independent of that task. The existing action labels describe a practice decision because the workspace and the tour are labeled throughout.

The first two stops require their practice actions before **Next** becomes available. After the decision, the remaining stops are quick to visit and inspections are optional. **Back** revisits the previous stop with the same practice records and decision. Repeat presses, double clicks, and stale callbacks leave one message, one decision, and one outcome. **Exit tutorial** is reachable at every stop.

## Timed approval help

Use the Cockpit's actual timed-allowance control and the eligibility for a document search. **Allow this tool in this Chat** opens the normal duration picker. For this sample it offers **15 minutes**, **1 hour**, and **8 hours**. Source the choices from the existing allowance contract for the tool so the copy and picker stay in sync.

A compact popover opens on hover, keyboard focus, or tap. It explains that in a real Chat, a timed allowance approves the request and lets that same Chat use the eligible tool again until the duration expires. Existing safety rules still apply. The popover directs the learner to **Approve once** or **Deny** for the exercise. Escape and an outside interaction dismiss the popover while the approval review stays available. Keep the chooser interactive and show **Approve and allow** as unavailable in the tutorial. The practice action boundary refuses a timed confirmation even if a stale or synthetic click reaches it.

## Cockpit presentation

Use the existing Cockpit shell, routes, components, controls, theme tokens, and responsive layout. The tour adds a clearly labeled practice context, a spotlight on the current control or region, and a compact card with **Back** and **Next** arrows, progress, and **Exit tutorial**. Each card names the control to use, explains its purpose, and tells the learner what should happen. Use the existing Distortion Wave for a brief accent at the new target. The outline and card remain readable if the effect is unavailable or reduced motion is enabled.

Anchor the card to stable elements owned by the real views. Prefer placement beside the target or on the side with available room. Maintain the target's visibility and leave the controls available. When the approval review opens as a phone sheet, keep the guide in the sheet and the explanation, duration picker, decision controls, and navigation reachable. For artifact previews, use the normal close action before advancing the guide. Move focus predictably after step changes, preserve it when copy updates after an action, and keep highlighted controls, the popover, and tour navigation keyboard reachable.

## Practice data and isolation

The implementation choice for the temporary session is a **browser-memory fixture** rendered in a dedicated tutorial instance of the Cockpit. The instance has its own query client, request transport, routing state, and cleanup owner. The practice route selects its transport at startup and uses that choice for the instance's lifetime. This lets the tour reuse the same views while keeping practice identities outside the live client's queries. Exact module and route names follow the existing app composition.

- A tab-local, one-use setup handoff carries the choice to enter the tour, presentation preferences for rendering, and the original Citadel and workspace identifiers. Confine sample payloads and record identities to the tutorial instance's memory. A one-use return notice can carry the completion or exit outcome and the requested scope back to the normal Cockpit.
- The fixture owns the example conversation, reply, request, task, and output in memory. Its state proceeds from ready to sent and then to one decision. Only the canned scenario is admitted. It uses example documents and a scripted response. The practice boundary exposes a fixed set of scoped reads and actions for the exercise, including a local approval decision. All other operations fail closed. Give unavailable controls a plain explanation and a way back to the exercise or ordinary Chat.
- Route sample reads, sends, approval actions, and any status events through the practice transport before a view mounts. The tutorial document can load the bundled Cockpit assets. Its application requests use the fixture only. An unsupported route, action, or transport fails within the tutorial. Live Gateway calls, model or tool execution, grants, installation settings, notifications, audit, learning, and artifact writes stay outside the fixture. Use explicit dependencies in the app and shared client. The browser overrides used by the visual mockup remain mockup code.
- Use the actual owner routes for the guided views. Constrain deep links and navigation to the practice instance or make them exit through the normal teardown. The tour's **Back** and **Next** manage step navigation within the instance. Keep practice steps out of the browser history. Scope tab state and transient effects to the instance, including event subscriptions, drafts, selection, and in-flight requests.
- Finish and Exit share teardown. Close the owner before releasing the view, abort pending work, dispose events and timers, clear the practice query cache and records, and return to normal Chat using the regular Cockpit entry. Cleanup is idempotent and completes before the landing notice. The normal Cockpit rechecks the requested return scope and opens Chat in that scope for the returning tab. Changes another tab saved remain intact. Use the normal authorized fallback if the original Citadel or workspace has become unavailable.
- Leaving through browser Back or closing the tab discards the session. Reload or a direct visit without an unused handoff opens normal Chat. A page restored from browser history treats a disposed session as ended.

## Acceptance

- A fresh user reaches the choice through each supported way of making a model ready. Skip proceeds through the existing safety review and normal Chat handoff. Take the tutorial uses the same review and waits for successful setup completion. An existing installation with completed setup gets its usual flow.
- The sample message and inline request render with the production Chat controls. The same pending request is inspectable in Inbox. Both decision paths settle once and show the correct task and artifact behavior. The tutorial's **Back** and **Next** retain the current practice state.
- The timed control and its eligible durations are visible in the review. Hover, focus, tap, and Escape behave as described. Timed confirmation stays unavailable. Verify the decision creates only a practice result.
- All eight stops use the actual Cockpit views. Visually inspect and exercise the composer, review panel and phone sheet, duration picker and popover, task detail, artifact preview, and entry and exit in light and dark themes at desktop and phone widths. Check targets and card placement, keyboard focus, rapid step changes, and reduced motion. Record any environment or state that could not be exercised.
- Finish, Exit, skip, reload, browser Back, and stale requests preserve durable data and leave no sample entries in the normal workspace, Chat history, Inbox, Work, Library, or notifications. Check a second tab changing the saved workspace while the tour is open, and check the return path when the original scope is unavailable. Verify cache and preference isolation and confirm the tour reaches no live provider, tool runner, grant or storage owner.
- Use focused onboarding, practice-transport, and scenario tests, plus rendered surface and accessibility checks. Exercise the installed Windows entry and cleanup path as part of desktop verification because first launch is in scope.

The implementation plan can choose exact component and fixture organization, trusted route and transport seams, and the focused test split. Bring material changes to the approved flow or isolation contract back for review.
