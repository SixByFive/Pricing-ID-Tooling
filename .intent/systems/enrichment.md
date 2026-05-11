---
id: sys-enrichment
title: Card data enrichment pipeline
type: system
created: '2026-05-11T15:56:22.654Z'
updated: '2026-05-11T15:56:22.654Z'
plans:
  - plan-variant-migration
  - plan-product-matching
decisions:
  - DEC-0001
  - DEC-0002
  - DEC-0003
tags:
  - tcgtracking
  - cards-database
  - enrichment
---
## Overview

Standalone external tooling that enriches TCGDex card source files with third-party marketplace IDs (TCGPlayer product ID, CardMarket ID, CardTrader ID) and migrates cards from the simple `variants: Record<string, boolean>` shape to the detailed `variants: TCGDexVariant[]` shape.

This tool operates against a local clone of the cards-database repo. It is not part of that repo — it is a one-time (or per-set) migration tool that produces PRs for human review.

**Source of truth:** TCGTracking `/tcgapi/v1/{categoryId}/sets/{setId}` — returns all products for a set, each with TCGPlayer product ID, CardMarket ID, CardTrader ID, and finish information.

## Boundaries

- Reads card files from a cards-database repo path passed via `--repo`
- Only touches cards where `variants` is NOT already a `TCGDexVariant[]` array
- Only touches cards that have `thirdParty.tcgplayer` (product ID) — used as the match key
- Does not touch set files, serie files, or any non-card data
- Never overwrites existing detailed variants — those are handled separately
- Writes are gated behind `--apply`; default is dry-run

## Key Decisions

- [DEC-0001] TCGTracking `/sets/{id}` is the source of truth — it gives all three IDs in one request per set
- [DEC-0002] Match products to card files by collector number first, card name as fallback
- [DEC-0003] Default dry-run — `--apply` required to write; output is a diff report for review
