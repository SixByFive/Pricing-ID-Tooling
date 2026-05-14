---
id: plan-variant-migration
title: Migrate cards to detailed variants with third-party IDs
type: plan
status: active
created: '2026-05-11T15:56:31.748Z'
updated: '2026-05-13T00:00:00.000Z'
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

## Write Modes

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

**Mode C — fill missing CardTrader IDs only (safe mode for already-complete sets):**
- `--fill-missing-cardtrader` CLI flag / "Fill missing CardTrader IDs" UI button
- Only operates on detailed (`Array.isArray(card.variants)`) cards
- Never converts simple variants to detailed
- For each existing variant: if `thirdParty.cardtrader` is missing and a matched product has `cardtrader_id`, add it
- Never creates new variants
- Never removes top-level `thirdParty`
- Never overwrites existing `cardmarket`, `tcgplayer`, or `cardtrader`

## CardMarket Mapping Rules

**Base product (auto-mapped):**
- The CardMarket export marks one product per card as `bucket: 'base'` — this is automatically assigned the inferred SKU base variant (e.g. `type:normal`) and requires no manual mapping
- The user can override which product is treated as base via `baseOverrides[cardId]` in the manual map, fixing cases where CardMarket lists a stamped/cosmos/etc. product first

**Additional products (manually mapped):**
- Products with `bucket: 'additional'` (or any non-base product after an override) require a manual mapping to be written
- Manual mappings specify: `{ type, foil?, stamp?, size?, notes? }`

**Manual mapping as source of truth:**
- When `cardmarketReview` is present for a card, never use `product.cardmarket_id` as a fallback
- Only the manually mapped CardMarket product ID is written into `thirdParty.cardmarket`
- The base product's auto-mapped variant can still be overridden by saving an explicit manual mapping for it

**Variant merge vs create rules:**

Plain variants (type only, no foil/stamp/size):
- `type:normal`, `type:holo`, `type:reverse` → **merge only**
- If no matching generated variant exists, skip — do not create a standalone entry

Special variants (has foil, stamp, or size):
- `type:normal|stamp:set-logo` → create if missing, merge if existing
- `type:reverse|foil:cosmos` → create if missing, merge if existing
- `type:holo|size:jumbo` → create if missing, merge if existing

## Shared Rules

- Match product→variant by finish: variant key must match (type + optional foil/stamp/size)
- If only one product matched the card and only one variant exists, they match unconditionally
- Cards where all IDs are already present on all variants are written as-is (no-op) and counted as `skipped` in the report
- Top-level `thirdParty` is removed only in full-apply Mode A/B, not in Mode C
- **Only the `variants` block is modified** — splice just the variants property substring; never reprint the whole file via jscodeshift toSource()
- thirdParty property order: `cardmarket`, `tcgplayer`, `cardtrader`
- Preserve all existing variant fields (`foil`, `subtype`, `size`, `stamp`, etc.) — only add/update `thirdParty` keys
- Always write a JSON report alongside any `--apply` run
- Apply writes include per-file error context: file path + reason on failure
