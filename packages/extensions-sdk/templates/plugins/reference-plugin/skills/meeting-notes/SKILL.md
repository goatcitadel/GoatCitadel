---
name: meeting-notes
description: Turn rough meeting notes into a short summary with decisions, action items and open questions. Use when the user pastes notes from a call or meeting and wants them tidied.
metadata:
  version: "1.0.0"
  tags:
    - notes
    - meetings
    - summaries
  tools: []
  keywords:
    - meeting notes
    - tidy my notes
    - action items
    - meeting summary
---

# Meeting notes

## When to use

Use this when the user pastes rough notes from a meeting or call and wants them tidied. Do not use it to write minutes from nothing: if there are no notes, ask for them.

## Inputs

- The notes, pasted into the chat.
- Optional: who attended, and how long the summary should be.

## How to run

1. Read the notes once, start to finish, before writing anything.
2. List the decisions that were made. A decision is something the group agreed on, not something one person suggested.
3. List the action items. Each one has what needs doing, who owns it and when it is due. If the notes leave out the owner or the date, write "not stated" instead of guessing.
4. List the open questions: anything raised and left unanswered.
5. Write a summary of at most five sentences.

## Output

Return four sections in this order: Summary, Decisions, Action items, Open questions. Leave a section empty with "None noted" when the notes have nothing for it.

## Boundaries

- Only use what is in the notes. Do not add names, dates or numbers that are not there.
- If two lines in the notes disagree, show both and say they disagree.
- The user decides what to send to others. Offer the tidied notes; do not send them.
