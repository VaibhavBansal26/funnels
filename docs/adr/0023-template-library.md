# 0023: Template library as a backend resource

## Context
Templates were seven functions in a seed file, listed unfiltered, and could only be changed with a deploy. The product needs a real library: filtering, previews, versioned content, and new templates without a release.

## Decision
Templates are database rows (migration 020) seeded from code modules by a versioned, idempotent seed: a built-in is replaced only when its stored `version` is lower and nobody edited it (`customized`) or replaced it by import (`source`). The same JSON shape is the admin import/export format, validated by the page-save pipeline. Metadata (industry, goal, tags, product slots) is stored with the template so the API can filter and the wizard can bind products. Illustrations are CSS compositions; SVG stays out of the sanitiser.

## Alternatives
Templates as files read at runtime (no admin import, no filters in SQL); a separate template service (a second deploy unit for static data); allowing `data:image/svg+xml` for artwork (widens the sanitiser for decoration).

## Consequences
New templates need no deploy; upgrades never clobber edited or imported ones; funnels cloned from a template are independent copies. The seed runs on every boot (cheap: one query per template when up to date). Contrast is audited by an approximation (`templates/contrast.ts`), not a browser.
