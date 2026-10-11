# Artifacts: decks and documents

GoatCitadel-authored module, not part of upstream impeccable. Load it when the deliverable is a presentation (`presentations.create`) or a document (`documents.create`). The GoatCitadel renderer owns the drawing of PPTX, PDF, and DOCX files, so this module governs what goes on the slides and pages, not CSS or layout code.

## Mode

- A deck for an audience that must decide or act (a pitch, a launch, a review with asks) is **Persuade**: one idea per slide, proof beside every claim, a closing ask.
- A deck or document whose reader must understand something (research, status, a runbook, a brief, a report) is **Read**: structure for comprehension, specific headings in reading order, sources wherever a claim rests on one.
- Never **Experience**: the renderer has no stage for it.

## Grounding

- Research first when the user asks for research, current facts, sources, or citations.
- Use only facts supported by the conversation and successful tool evidence. Never turn the request itself into slide or section content.
- Preserve source URLs in the relevant bullets and include a final sources slide or section when sources exist.
- Distinguish verified facts from interpretation. Do not invent statistics, quotations, people, dates, or citations.
- If evidence is insufficient, explain what is missing instead of producing a generic deck or document.

## Structure

Decks:

- A topic-specific title; a subtitle only when it adds a frame the title cannot carry.
- Unless the user asks for a single slide, a narrative: an opening that states the point, logically grouped findings, practical takeaways, and sources when applicable.
- Each slide has a distinct purpose, a specific title, and three to five concise bullets grounded in the topic. No duplicate titles, no repeated bullets, no meta-copy such as "this slide summarizes the topic".
- Use the slide archetypes the tool offers: `comparison` for two options, `matrix` with a `table` for criteria against candidates, `chart` with real series for a trend, `section` for a divider, `closing` for the ask. A table or chart carries its own data; it is never restated in bullets.
- Bullets are complete thoughts, not labels: a reader without the speaker must get the point.

Documents:

- A title that names the subject and the kind of document (brief, report, memo, runbook).
- Sections with specific headings in reading order; the first states the conclusion or the question, the last states next steps or open questions.
- Body paragraphs for argument, bullets for parallel items, a table only for data that is tabular.

## Visual direction the renderer can take

- One coherent direction per artifact, chosen for the subject and audience. Set `design.preset` only when the subject clearly suggests one, and pass `design.brand` colors and fonts when the workspace design context supplies them; otherwise leave the renderer's defaults alone.
- Imagery only when it adds meaning and an authorized tool produced it; never fabricate an asset reference. Add a `visualBrief` on a slide only when a specific, subject-appropriate image would help.
- Readable contrast, clear hierarchy, restrained color. Do not ask for decoration.

## Artifact contract

- A request for PowerPoint, PPTX, slides, or a presentation file requires a successful `presentations.create` call; a document file requires `documents.create`. Prose alone is not completion.
- Provide a safe write path, a specific title, grounded slides or sections, and `design: { mode: "polished" }`; the runtime attaches the governed design skill itself. Use `minimal` or `plain` for raw data, logs, JSON, CSV, or explicitly plain output.
- Call the tool only after enough grounded content exists to pass the content-quality gate.
- Report the returned artifact path and format exactly. Do not claim creation when the tool is blocked, fails, times out, or waits on an approval.
- Never retry by submitting content made from the user's request text. On failure, preserve the failure and give the operator the next safe action.
