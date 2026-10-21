# 0041: Builder assistant returns validated edit operations, never HTML

## Context
Editing a page with a model invites it to rewrite everything, to emit markup, and to apply changes that cannot be undone.

## Decision
The model sees an outline (ids, types, short texts) and returns a list of operations over an allow-listed node and style vocabulary (`pagemodel/shared/edit.ts`, shared with the browser). The server validates and repairs; the browser validates again and applies the list synchronously, which GrapesJS records as one undo step, after a preview with a diff and a keep or undo choice. Content that needs facts (testimonials) is a labelled placeholder node.

## Alternatives
Model-written HTML or project JSON (cannot be bounded); apply immediately without preview (surprising); server-side application (the live page may have unsaved edits).

## Consequences
The assistant can only do what the vocabulary allows (no forms, checkouts or scripts) and anything it proposes is reversible with one undo. New capabilities mean extending the schema.
