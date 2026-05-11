---
id: plan-variant-migration
title: Migrate cards to detailed variants with third-party IDs
type: plan
status: active
created: '2026-05-11T15:56:31.748Z'
updated: '2026-05-11T15:56:31.748Z'
system: enrichment
decisions:
  - DEC-0001
  - DEC-0002
  - DEC-0003
constraints: []
tags:
  - migration
  - variants
  - cardmarket
  - cardtrader
  - tcgplayer
---
## Goal

For every card file in the target set, ensure `variants` is a `TCGDexVariant[]` array where each entry carries the finish and all three third-party IDs (tcgplayer, cardmarket, cardtrader) sourced from TCGTracking.

## Reason

The detailed variants shape is the target state for the cards-database. It allows per-variant pricing, per-variant marketplace links, and is required before CardMarket and CardTrader IDs can be stored at variant granularity. Many cards already have the detailed array shape but are missing IDs (cardmarket, cardtrader, or both). We must handle both cases.

TCGTracking's `/sets/{id}` response groups products by finish, giving us all the data needed in a single request per set.

## Rules

**All cards in a set are eligible — two write modes:**

**Mode A — simple→detailed (card has no detailed variants yet):**
- `Array.isArray(card.variants)` is `false` (simple `{ normal: true }` shape or no variants)
- Build a fresh `variants: TCGDexVariant[]` array from the matched TCGTracking products
- Each entry: `type` (finish normalised to TCGDex convention) + `thirdParty: { tcgplayer, cardmarket?, cardtrader? }`

**Mode B — merge IDs into existing detailed variants:**
- `Array.isArray(card.variants)` is `true` (already detailed)
- For each existing variant entry, find the matching TCGTracking product by finish type
- Add any missing `thirdParty` keys (tcgplayer, cardmarket, cardtrader) to that entry
- If no product maps to a variant's finish, leave that variant unchanged
- Mark the card `reviewRequired` in the report if any variant had no product match

**Shared rules:**
- Match product→variant by finish: `normaliseFinish(product)` must equal the variant's `type`
- If only one product matched the card and only one variant exists, they match unconditionally
- Cards where all IDs are already present on all variants are written as-is (no-op) and counted as `skipped` in the report
- Do not remove or touch the top-level `thirdParty` field — that is a separate cleanup step
- **Only the `variants` block is modified** — use Babel AST position info (.start/.end) to splice just the variants property substring; never reprint the whole file via jscodeshift toSource()
- thirdParty property order: `cardmarket`, `tcgplayer`, `cardtrader` (matching existing Ascended Heroes convention)
- Preserve all existing variant fields (`foil`, `subtype`, `size`, `stamp`, etc.) — only add/update `thirdParty` keys
- Always write a JSON report alongside any `--apply` run
