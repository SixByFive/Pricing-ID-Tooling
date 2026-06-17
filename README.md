# Pricing-ID Tooling

Enriches [TCGDex](https://github.com/tcgdex) card `.ts` files with third-party marketplace IDs — TCGPlayer product IDs, CardMarket product IDs — sourced from the [TCGTracking](https://tcgtracking.com) API and optional CardMarket exports.

## Running

### UI (recommended)

```
bun run ui
```

Opens the web interface at **http://localhost:3001**. Use this for day-to-day work — it shows a dry-run diff before you apply, and has a CardMarket mapping panel for resolving ambiguous products.

### CLI

```
bun run enrich -- --repo <path> --set <serie/set> [options]
```

Examples:

```sh
# Dry-run (preview only)
bun run enrich -- --repo H:/cards-database --set "Scarlet & Violet/Obsidian Flames"

# Apply changes
bun run enrich -- --repo H:/cards-database --set "Scarlet & Violet/Obsidian Flames" --apply

# With CardMarket data
bun run enrich -- --repo H:/cards-database --set "Scarlet & Violet/Obsidian Flames" \
  --cardmarket-json ./cardmarket-OBF-merged.json --apply
```

## UI Guide

| Field | Purpose |
|---|---|
| **Repo path** | Absolute path to your local `cards-database` clone |
| **Set** | Select from the tree; filters as you type |
| **CardMarket merge JSON** | Export file from the CardMarket merge script (see [File formats](#file-formats)) |
| **CardMarket manual map** | Auto-created beside the merge JSON on first save; override the path here if needed |
| **TCGPlayer set JSON** | Local export from `sbf-tcgplayer-set-exporter`, or a raw TCGTracking API response. Use when the set has no `thirdParty.tcgplayer` in the database, or to avoid API calls |
| **TCGPlayer set ID** | Numeric override for the TCGPlayer set ID when the set file lacks `thirdParty.tcgplayer` |

### CardMarket mapping panel

After a dry-run, cards that have CardMarket products but ambiguous variant assignments appear with a **Needs CM mapping** badge. Click a row to expand it and assign each product to a variant (`type`, `foil`, `stamp`, etc.). Mappings are saved immediately and persist in the manual map file.

### Modes

- **Dry-run** — reads files and produces a diff report; nothing is written
- **Apply** — writes changes to card files; blocked if any CardMarket products are still unmapped
- **Fill missing CardTrader** — safe backfill: adds CardTrader IDs to existing detailed variants only, never creates new variants or overwrites existing IDs

## CLI options

```
--repo <path>              Path to the cards-database repo. Defaults to cwd.
--set <set>                Set path, e.g. "Scarlet & Violet/Obsidian Flames"
--apply                    Write changes. Without this, dry-run only.
--fill-missing-cardtrader  Safe CardTrader backfill mode (see Modes above).
--cardmarket-json <path>   CardMarket merged export JSON.
--cardmarket-map <path>    Manual CardMarket mapping file.
                           Defaults to <cardmarket-json>.manual-map.json
--tcgplayer-set-id <id>    Override the TCGPlayer set ID.
--tcgplayer-json <path>    Local TCGPlayer set JSON file.
--help, -h                 Show help.
```

## File formats

### CardMarket merge JSON

Produced by the CardMarket merge script. Shape:

```json
{
  "stats": { "mergedKeys": 99 },
  "byCardId": {
    "OBF-001": {
      "cardmarketProducts": [
        { "productId": 123456, "name": "Deoxys", "expansionCode": "OBF", ... }
      ]
    }
  }
}
```

### CardMarket manual map

Auto-created at `<merge-json>.manual-map.json`. Stores your manual variant assignments:

```json
{
  "meta": { "tool": "pricing-id-tooling", "version": 1, "updatedAt": "..." },
  "cards": {
    "OBF-001": {
      "123456": { "type": "holo", "stamp": ["cosmos"] }
    }
  }
}
```

### TCGPlayer JSON

Two formats are accepted:

**TCGTracking API response** (fetched directly or saved locally):
```json
{ "set_id": 24655, "set_name": "Obsidian Flames", "products": [ ... ] }
```

**`sbf-tcgplayer-set-exporter` format**:
```json
{
  "meta": { "groupId": 24655, "groupKey": "sv3pt5", "groupName": "Obsidian Flames" },
  "byCardId": {
    "OBF-001": {
      "tcgplayerProducts": [
        { "productId": 560311, "name": "Deoxys", "printings": ["Holofoil"] }
      ]
    }
  }
}
```

## Architecture

| File | Role |
|---|---|
| `src/server.ts` | Bun HTTP server, serves the UI and exposes the API endpoints |
| `src/cli.ts` | CLI entry point, thin wrapper around `runEnrichment` |
| `src/enrichment.ts` | Orchestrates a full enrichment run: loads data, matches, diffs, writes |
| `src/matcher.ts` | Matches TCGTracking products to card files by collector number or name |
| `src/writer.ts` | Builds and writes the `variants` array in card `.ts` files |
| `src/variant-resolver.ts` | Resolves TCGTracking SKU/product data to typed variant identities |
| `src/cardmarket-merge.ts` | Loads and saves the CardMarket merge context and manual mapping |
| `src/tcgtracking.ts` | TCGTracking API client (fetch products, fetch SKUs) |
| `src/types.ts` | Shared TypeScript types |
| `public/index.html` | Single-file UI (vanilla JS + CSS, no build step) |

## Development

```sh
bun install       # install dependencies
bun run typecheck # type-check only
bun run ui        # start the dev server
```

Runtime and package manager: [Bun](https://bun.sh)
