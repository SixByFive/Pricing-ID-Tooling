---
id: plan-product-matching
title: Match TCGTracking products to card files
type: plan
status: active
created: '2026-05-11T15:56:32.111Z'
updated: '2026-05-11T15:56:32.111Z'
system: enrichment
decisions:
  - DEC-0001
  - DEC-0002
constraints: []
tags:
  - matching
  - collector-number
---
## Goal

Given the list of TCGTracking products for a set and the list of card files in the corresponding set directory, produce a reliable mapping of `cardFile → TCGTracking product[]`.

## Reason

TCGTracking products do not directly reference card file names. The match must be inferred. Collector number is the most stable identifier but is absent on some older sets and promos. Name matching is a fallback and is inherently fuzzy.

The quality of the match directly determines the quality of the migration — a wrong match writes the wrong IDs into a card file.

## Rules

**Primary match — collector number:**
- TCGTracking product has a `number` field (may be null)
- TCGTracking stores numbers as `001/165` (with `/total` suffix) — strip the suffix before normalising
- Card file name is typically the collector number (e.g. `001.ts`, `001a.ts`) — no suffix
- Normalise: split on `/`, take first part, strip leading zeros, lowercase, trim
- **All** products sharing a collector number are matched to the card — they represent different variants (normal, reverse holo, cosmos, stamped, etc.)
- Do NOT use the existing card-level tcgplayer ID to narrow number matches — we want all variants

**Fallback — card name:**
- Use only when collector number match yields zero results for a card
- Use `product.name` (e.g. `"Bulbasaur"`) NOT `product.clean_name` (e.g. `"Bulbasaur 001 165"` which appends number/total)
- Normalise both names: lowercase, strip punctuation, collapse whitespace
- Accept only exact normalised matches — no fuzzy/Levenshtein
- Flag name-matched cards in the report for human review before apply
- If the card has an existing card-level tcgplayer ID, prefer the product with that ID (sanityFilter) to avoid name collisions

**Ambiguous matches:**
- Only applies to name-fallback: if multiple different cards match the same name, record as `ambiguous`
- Do not write ambiguous cards — require manual resolution

**Unmatched:**
- Cards with no matching product are recorded as `unmatched`
- Products with no matching card are recorded as `orphan-products`
