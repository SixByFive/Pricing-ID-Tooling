---
id: plan-web-ui
title: Web UI for controlling enrichment runs
type: plan
status: active
created: '2026-05-11T16:01:38.734Z'
updated: '2026-05-11T16:01:38.734Z'
system: enrichment
decisions:
  - DEC-0003
  - DEC-0004
constraints: []
tags:
  - ui
  - server
---
## Goal

A browser-based UI served by a local Bun HTTP server that lets the user configure the repo path, browse available sets, run dry-run or apply, see live output as the run streams, and inspect the final report — without touching the CLI directly.

## Reason

The CLI is the correct interface for CI and automation. The UI is for interactive use: reviewing matches, understanding what will change before committing to --apply, and inspecting ambiguous/unmatched cards in a readable format.

## Rules

**Server (`src/server.ts`):**
- Bun HTTP server, single file, no framework
- `GET /api/sets?repo=<path>` — scan `data/` in the repo, return `serie/set` pairs
- `POST /api/run` body `{ repo, set, apply }` — spawn CLI as subprocess, stream stdout/stderr as SSE
- `GET /api/report?set=<slug>` — read last JSON report from `var/reports/`
- Serve `public/index.html` as the root

**UI (`public/index.html`):**
- Single self-contained HTML file — no build step, no bundler
- Two-panel layout: left sidebar (repo config + set list), right main area (controls + output + report)
- Repo path is persisted in localStorage
- Set list loads on repo path change; searchable/filterable
- Dry-run and Apply buttons; Apply is visually distinct (destructive action colour)
- Live output streams via SSE into a scrolling log panel
- After run completes, report renders inline: summary counts, matched/ambiguous/unmatched tables
- Name-matched cards flagged for review are highlighted

**Separation:**
- Core enrichment logic lives in `src/enrichment.ts` (extracted from cli.ts)
- `src/cli.ts` and `src/server.ts` are both thin wrappers over `src/enrichment.ts`
