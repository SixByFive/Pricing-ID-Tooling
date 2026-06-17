// ==UserScript==
// @name         Cardmarket Set Merge Exporter (Any Set + Pagination + Reliable Export)
// @namespace    sixbyfive-tools
// @version      3.5.5
// @description  Collects Cardmarket productIds + variant names from Pokemon Singles set pages. Supports both the new grid layout (2025+) and legacy productRow layout. Merges across slugs by derived groupKey.
// @match        https://www.cardmarket.com/*/Pokemon/Products/Singles/*
// @match        https://www.cardmarket.com/*/Pokemon/Products/Singles/*/*
// @grant        GM_setClipboard
// ==/UserScript==

(function () {
  "use strict";

  // ===========================================================================
  // Optional per-set overrides
  // ===========================================================================
  const SET_OVERRIDES = {
    // "Prismatic-Evolutions-Additionals": { forceBucket: "additional", canonicalSetCodeOverride: "PRE" },
  };

  // ===========================================================================
  // Storage
  // ===========================================================================
  const STORE_KEY_PREFIX = "sbf_cm_set_merge_store_v4::";

  const GROUP_INDEX_KEY = "sbf_cm_set_merge_group_index_v1";
  // shape: { [setSlug]: { groupKey, lastSeenAt } }

  function loadGroupIndex() {
    try {
      const raw = localStorage.getItem(GROUP_INDEX_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  function saveGroupIndex(index) {
    localStorage.setItem(GROUP_INDEX_KEY, JSON.stringify(index));
  }

  function rememberGroupForSlug(setSlug, groupKey) {
    if (!setSlug || !groupKey) return;
    const index = loadGroupIndex();
    index[setSlug] = { groupKey, lastSeenAt: new Date().toISOString() };
    saveGroupIndex(index);
  }

  function getRememberedGroupForSlug(setSlug) {
    const index = loadGroupIndex();
    return index?.[setSlug]?.groupKey || null;
  }

  function getStoreKey(groupKey) {
    return `${STORE_KEY_PREFIX}${groupKey || "unknown-group"}`;
  }

  function loadStore(groupKey) {
    try {
      const raw = localStorage.getItem(getStoreKey(groupKey));
      if (!raw) return { pages: [], entries: {}, seenPageIds: {} };
      const parsed = JSON.parse(raw);
      return {
        pages: Array.isArray(parsed.pages) ? parsed.pages : [],
        entries: parsed.entries && typeof parsed.entries === "object" ? parsed.entries : {},
        seenPageIds: parsed.seenPageIds && typeof parsed.seenPageIds === "object" ? parsed.seenPageIds : {},
      };
    } catch {
      return { pages: [], entries: {}, seenPageIds: {} };
    }
  }

  function saveStore(groupKey, store) {
    try {
      localStorage.setItem(getStoreKey(groupKey), JSON.stringify(store));
    } catch (e) {
      if (e.name === "QuotaExceededError" || e.code === 22) {
        setStatus("localStorage full — click 'Purge old data' to free space, then re-collect.", false);
      }
      throw e;
    }
  }

  // Slim down all existing stores written by older script versions (which stored
  // a full `sources` array and fat fields on every cardmarketProducts entry).
  function pruneAllStores() {
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(STORE_KEY_PREFIX)) keys.push(k);
      }
      for (const key of keys) {
        try {
          const raw = localStorage.getItem(key);
          if (!raw) continue;
          const store = JSON.parse(raw);
          let changed = false;
          for (const entry of Object.values(store.entries || {})) {
            if (entry.sources) { delete entry.sources; changed = true; }
            if (Array.isArray(entry.cardmarketProducts)) {
              entry.cardmarketProducts = entry.cardmarketProducts.map((p) => {
                if (!("url" in p) && !("setSlug" in p) && !("rawCardId" in p)) return p;
                changed = true;
                return { productId: p.productId, name: p.name || "", variantLabel: p.variantLabel || "", bucket: p.bucket || "" };
              });
            }
          }
          if (changed) localStorage.setItem(key, JSON.stringify(store));
        } catch { /* skip corrupt key */ }
      }
    } catch (e) {
      console.warn("[SBF Exporter] pruneAllStores error:", e);
    }
  }

  function clearStore(groupKey) {
    localStorage.removeItem(getStoreKey(groupKey));
  }

  // ===========================================================================
  // UI
  // ===========================================================================
  const ui = document.createElement("div");
  ui.id = "sbf-cm-merge-exporter";
  ui.style.cssText = `
    position: fixed;
    top: 14px;
    right: 14px;
    z-index: 999999;
    width: 500px;
    font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    color: #e5e7eb;
  `;

  ui.innerHTML = `
    <div style="
      border: 1px solid #1f2937;
      background: rgba(2,6,23,0.92);
      backdrop-filter: blur(6px);
      border-radius: 14px;
      box-shadow: 0 14px 40px rgba(0,0,0,0.40);
      overflow: hidden;
    ">
      <div style="padding: 10px 12px; display:flex; align-items:center; justify-content:space-between; gap:10px;">
        <div style="font-weight: 900; font-size: 13px; letter-spacing: .2px;">
          SBF • Cardmarket Set Merge Export
        </div>
        <button id="sbf-close" title="Hide" style="
          border: 1px solid #1f2937; background: transparent; color: #9ca3af;
          border-radius: 10px; padding: 4px 10px; cursor: pointer; font-size: 14px;
        ">×</button>
      </div>

      <div style="padding: 0 12px 12px;">
        <div style="font-size: 12px; color: #9ca3af; margin-bottom: 10px; line-height: 1.35;">
          Collect base + additionals pages across pagination (<b>site=</b>).<br/>
          Merge key is derived from row set codes (<b>XPRE</b> merges into <b>PRE</b>).<br/>
          <b>Export is reliable</b>: it uses a stored <code>setSlug → groupKey</code> index.<br/>
          <b>Variant names included</b>: export now stores Cardmarket product names and inferred labels.
        </div>

        <div id="sbf-detected" style="
          border: 1px solid #1f2937;
          background: #0b1220;
          border-radius: 12px;
          padding: 10px;
          font-size: 12px;
          color: #cbd5e1;
          margin-bottom: 10px;
          line-height: 1.35;
        "></div>

        <div style="display:flex; gap:8px; margin-bottom: 10px;">
          <button id="sbf-collect" style="
            flex: 1;
            border: 1px solid #1f2937;
            background: #2563eb;
            color: white;
            border-radius: 12px;
            padding: 10px 10px;
            cursor: pointer;
            font-weight: 900;
            font-size: 12px;
          ">Collect this page</button>

          <button id="sbf-collectNext" style="
            border: 1px solid #1f2937;
            background: #111827;
            color: #e5e7eb;
            border-radius: 12px;
            padding: 10px 10px;
            cursor: pointer;
            font-weight: 900;
            font-size: 12px;
            white-space: nowrap;
          ">Collect + Next</button>

          <button id="sbf-next" style="
            border: 1px solid #1f2937;
            background: transparent;
            color: #e5e7eb;
            border-radius: 12px;
            padding: 10px 10px;
            cursor: pointer;
            font-weight: 900;
            font-size: 12px;
            white-space: nowrap;
          ">Open Next</button>
        </div>

        <div style="display:flex; gap:8px; margin-bottom: 10px;">
          <button id="sbf-export" style="
            flex: 1;
            border: 1px solid #1f2937;
            background: transparent;
            color: #e5e7eb;
            border-radius: 12px;
            padding: 10px 10px;
            cursor: pointer;
            font-weight: 900;
            font-size: 12px;
          ">Export (Copy)</button>

          <button id="sbf-download" style="
            border: 1px solid #1f2937;
            background: transparent;
            color: #e5e7eb;
            border-radius: 12px;
            padding: 10px 10px;
            cursor: pointer;
            font-weight: 900;
            font-size: 12px;
          ">Download</button>
        </div>

        <div style="display:flex; gap:8px; align-items:center; margin-bottom: 10px;">
          <button id="sbf-reset" style="
            border: 1px solid #1f2937;
            background: #111827;
            color: #e5e7eb;
            border-radius: 12px;
            padding: 8px 10px;
            cursor: pointer;
            font-weight: 900;
            font-size: 12px;
          ">Reset collected (this group)</button>

          <button id="sbf-purge" title="Remove sources arrays and trim fat fields from all stored sets to free localStorage space" style="
            border: 1px solid #1f2937;
            background: #111827;
            color: #fbbf24;
            border-radius: 12px;
            padding: 8px 10px;
            cursor: pointer;
            font-weight: 900;
            font-size: 12px;
          ">Purge old data</button>

          <label style="display:flex; gap:8px; align-items:center; font-size: 12px; color:#cbd5e1;">
            <input id="sbf-debug" type="checkbox" />
            Debug
          </label>
        </div>

        <div id="sbf-status" style="margin-top: 6px; font-size: 12px; color: #9ca3af;"></div>

        <pre id="sbf-debugOut" style="
          display:none;
          margin-top:10px;
          max-height: 320px;
          overflow:auto;
          background: #020617;
          border: 1px solid #1f2937;
          border-radius: 12px;
          padding: 10px;
          font-size: 11px;
          line-height: 1.35;
          color: #e5e7eb;
        "></pre>
      </div>
    </div>
  `;

  document.body.appendChild(ui);

  const $ = (sel) => ui.querySelector(sel);

  $("#sbf-close").addEventListener("click", () => ui.remove());
  $("#sbf-debug").addEventListener("change", (e) => {
    $("#sbf-debugOut").style.display = e.target.checked ? "block" : "none";
  });

  // ===========================================================================
  // Helpers
  // ===========================================================================
  function setStatus(msg, ok = true) {
    $("#sbf-status").textContent = msg;
    $("#sbf-status").style.color = ok ? "#9ca3af" : "#fca5a5";
  }

  function setDebug(obj) {
    $("#sbf-debugOut").textContent = JSON.stringify(obj, null, 2);
  }

  function downloadText(filename, text) {
    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function copyText(text) {
    if (typeof GM_setClipboard === "function") {
      GM_setClipboard(text);
      return Promise.resolve();
    }
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);

    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    return Promise.resolve();
  }

  function normalizeSetCode(code) {
    return String(code || "").trim().toUpperCase();
  }

  function pad3(n) {
    const s = String(n).trim();
    return s.length >= 3 ? s : s.padStart(3, "0");
  }

  function getSetSlugFromUrl() {
    const parts = location.pathname.split("/").filter(Boolean);
    const idx = parts.findIndex((p) => p === "Singles");
    if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
    return parts[parts.length - 1] || "unknown-set";
  }

  function getSetNameFromPage() {
    const h1 = document.querySelector("h1")?.textContent?.trim();
    return h1 || document.title || "Cardmarket Singles";
  }

  function getOverrides(setSlug) {
    return SET_OVERRIDES[setSlug] || null;
  }

  function getPageParam() {
    const u = new URL(location.href);
    const site = u.searchParams.get("site");
    if (site && /^\d+$/.test(site)) return Number(site);
    const page = u.searchParams.get("page");
    if (page && /^\d+$/.test(page)) return Number(page);
    return 1;
  }

  function getNextPageUrl() {
    const u = new URL(location.href);
    const current = getPageParam();

    if (u.searchParams.has("site") || !u.searchParams.has("page")) {
      u.searchParams.set("site", String(current + 1));
      u.searchParams.delete("page");
      return u.toString();
    }

    u.searchParams.set("page", String(current + 1));
    return u.toString();
  }

  function cleanDisplayName(displayText) {
    const text = String(displayText || "").trim();
    if (!text) return "";

    const withoutCode = text.replace(/\s*\(([a-zA-Z0-9]+)\s+([0-9]{1,4}[a-zA-Z]?)\).*/i, "").trim();

    return withoutCode
      .replace(/\s*From\s+.+$/i, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function inferVariantLabelFromName(name) {
    const n = String(name || "").toLowerCase();

    if (n.includes("master ball") || n.includes("masterball")) return "masterball";
    if (n.includes("poke ball") || n.includes("poké ball") || n.includes("pokeball")) return "pokeball";
    if (n.includes("love ball") || n.includes("loveball")) return "loveball";
    if (n.includes("friend ball") || n.includes("friendball")) return "friendball";
    if (n.includes("quick ball") || n.includes("quickball")) return "quickball";
    if (n.includes("dusk ball") || n.includes("duskball")) return "duskball";
    if (n.includes("great ball") || n.includes("greatball")) return "greatball";
    if (n.includes("ultra ball") || n.includes("ultraball")) return "ultraball";
    if (n.includes("energy symbol")) return "energy";
    if (n.includes("team rocket") || n.includes("team-rocket")) return "team-rocket";
    if (n.includes("reverse holo") || n.includes("reverse-holo")) return "reverse-holo";
    if (n.includes("holo")) return "holo";

    return "";
  }

  // ===========================================================================
  // Page classification (base vs additional)
  // ===========================================================================
  function inferPageBucket(setSlug) {
    const url = location.href.toLowerCase();
    const slug = String(setSlug || "").toLowerCase();

    const override = getOverrides(setSlug);
    if (override?.forceBucket) return override.forceBucket;

    if (url.includes("additionals") || slug.includes("additionals") || slug.includes("additional")) return "additional";
    if (slug.includes("variant") || slug.includes("variants")) return "additional";

    return "base";
  }

  // ===========================================================================
  // Extraction logic
  // ===========================================================================
  const PRODUCT_ROW_ID_RE = /^productRow(\d+)$/;
  const IMG_PRODUCT_ID_RE = /(\d{4,})\/\d+\.(?:jpg|png|webp)/;

  function getProductRows() {
    const gridCards = Array.from(
      document.querySelectorAll('.col-12.col-sm-6.col-md-4.col-lg-3')
    ).filter((el) => el.querySelector('a[href*="/Pokemon/Products/Singles/"]'));

    if (gridCards.length > 0) return gridCards;

    const legacyRows = Array.from(document.querySelectorAll('div[id^="productRow"]'));
    if (legacyRows.length > 0) return legacyRows;

    const links = Array.from(document.querySelectorAll('a[href*="/Pokemon/Products/Singles/"]'));
    const parents = links
      .map((a) => a.closest("div"))
      .filter(Boolean);
    return parents;
  }

  function extractProductId(rowEl) {
    const img = rowEl.querySelector("img");
    if (img) {
      // Use getAttribute (not the .src property) so lazy-loaded images with no real src
      // attribute don't short-circuit the chain — img.src always resolves to a non-empty
      // absolute URL even when the attribute is absent or a placeholder.
      for (const src of [
        img.getAttribute("src"),
        img.getAttribute("data-echo"),
        img.getAttribute("data-src"),
        img.getAttribute("srcset"),
        img.getAttribute("data-srcset"),
      ]) {
        if (!src) continue;
        const m = src.match(IMG_PRODUCT_ID_RE);
        if (m) return Number(m[1]);
      }
    }

    const idAttr = rowEl.getAttribute("id") || "";
    const legacyMatch = idAttr.match(PRODUCT_ROW_ID_RE);
    if (legacyMatch) return Number(legacyMatch[1]);

    return null;
  }

  function extractDisplayText(rowEl) {
    const a = rowEl.querySelector('a[href*="/Pokemon/Products/Singles/"]') || rowEl.querySelector("a");
    return (a?.textContent || "").trim();
  }

  function parseCardIdFromDisplay(displayText) {
    const m = String(displayText).match(/\(([a-zA-Z0-9]+)\s+([a-zA-Z]{0,3}[0-9]{1,4}[a-zA-Z]?)\)/);
    if (!m) return null;

    const setCode = normalizeSetCode(m[1]);
    const numRaw = String(m[2]).trim();

    const n = numRaw.match(/^(\d+)([a-zA-Z]?)$/);
    if (!n) return `${setCode}-${numRaw}`;

    const padded = pad3(n[1]);
    const suffix = (n[2] || "").toUpperCase();

    return `${setCode}-${padded}${suffix}`;
  }

  function toCanonicalCardId(rawCardId) {
    const m = String(rawCardId || "").match(/^([A-Z0-9]+)-([A-Z]{0,3}\d{1,4}[A-Z]?)$/);
    if (!m) return null;
    const rawSetCode = m[1];
    const num = m[2];
    const canonicalSetCode = rawSetCode.startsWith("X") ? rawSetCode.slice(1) : rawSetCode;
    return `${canonicalSetCode}-${num}`;
  }

  function getGroupKeyFromPage(setSlug) {
    const override = getOverrides(setSlug);
    if (override?.canonicalSetCodeOverride) return normalizeSetCode(override.canonicalSetCodeOverride);

    const rows = getProductRows();
    for (const row of rows) {
      const display = extractDisplayText(row);
      const rawCardId = parseCardIdFromDisplay(display);
      const canonical = rawCardId ? toCanonicalCardId(rawCardId) : null;
      if (canonical) {
        const m = canonical.match(/^([A-Z0-9]+)-/);
        if (m) return m[1];
      }
    }

    return `SLUG__${setSlug}`;
  }

  function resolveGroupKey(setSlug) {
    const derived = getGroupKeyFromPage(setSlug);

    if (derived && !derived.startsWith("SLUG__")) {
      return derived;
    }

    const remembered = getRememberedGroupForSlug(setSlug);
    if (remembered && !remembered.startsWith("SLUG__")) {
      return remembered;
    }

    const index = loadGroupIndex();
    for (const [slug, entry] of Object.entries(index)) {
      if (!entry?.groupKey || entry.groupKey.startsWith("SLUG__")) continue;
      if (setSlug.startsWith(slug) || slug.startsWith(setSlug)) {
        return entry.groupKey;
      }
    }

    return derived;
  }

  function uniqSorted(nums) {
    const out = Array.from(new Set(nums.filter((n) => Number.isFinite(n))));
    out.sort((a, b) => a - b);
    return out;
  }

  // ===========================================================================
  // UI detection panel
  // ===========================================================================
  function renderDetected() {
    const setSlug = getSetSlugFromUrl();
    const setName = getSetNameFromPage();
    const bucket = inferPageBucket(setSlug);
    const pageNum = getPageParam();

    const groupKey = resolveGroupKey(setSlug);
    const store = loadStore(groupKey);

    const baseCount = Object.values(store.entries).filter((e) => e?.ids?.base?.length).length;
    const addCount = Object.values(store.entries).filter((e) => e?.ids?.additional?.length).length;

    const nextUrl = getNextPageUrl();
    $("#sbf-next").disabled = (nextUrl === location.href);
    $("#sbf-collectNext").disabled = (nextUrl === location.href);

    $("#sbf-detected").innerHTML = `
      <div style="display:flex; justify-content:space-between; gap:10px;">
        <div>
          <div style="font-weight:900; color:#e5e7eb;">Detected</div>
          <div style="color:#94a3b8; margin-top:2px;">Set slug: <b style="color:#e5e7eb;">${setSlug}</b></div>
          <div style="color:#94a3b8; margin-top:2px;">Bucket: <b style="color:#e5e7eb;">${bucket}</b></div>
          <div style="color:#94a3b8; margin-top:2px;">Page: <b style="color:#e5e7eb;">${pageNum}</b> (<code>site=</code>)</div>
          <div style="color:#94a3b8; margin-top:2px;">Group key: <b style="color:#e5e7eb;">${groupKey}</b></div>
          <div style="color:#94a3b8; margin-top:2px;">Title: ${setName}</div>
        </div>

        <div style="text-align:right;">
          <div style="font-weight:900; color:#e5e7eb;">Collected (group)</div>
          <div style="color:#94a3b8; margin-top:2px;">base keys: <b style="color:#e5e7eb;">${baseCount}</b></div>
          <div style="color:#94a3b8; margin-top:2px;">additional keys: <b style="color:#e5e7eb;">${addCount}</b></div>
          <div style="color:#94a3b8; margin-top:2px;">pages: <b style="color:#e5e7eb;">${store.pages.length}</b></div>
        </div>
      </div>
    `;
  }

  // ===========================================================================
  // Collect + Merge
  // ===========================================================================
  function collectThisPage() {
    const setSlug = getSetSlugFromUrl();
    const pageName = getSetNameFromPage();
    const bucket = inferPageBucket(setSlug);

    const groupKey = resolveGroupKey(setSlug);
    rememberGroupForSlug(setSlug, groupKey);

    const rows = getProductRows();

    const page = {
      pageId: `${bucket}::${location.pathname}${location.search}`,
      url: location.href,
      kind: "set",
      bucket,
      setSlug,
      groupKey,
      setName: pageName,
      collectedAt: new Date().toISOString(),
      stats: {
        rowsSeen: rows.length,
        rowsWithProductId: 0,
        rowsWithRawCardId: 0,
        rowsWithCanonicalCardId: 0,
        rowsPaired: 0,
      },
    };

    const store = loadStore(groupKey);

    if (store.seenPageIds[page.pageId]) {
      setStatus(`Already collected this page (${bucket}, page ${getPageParam()}) for group ${groupKey}.`, true);
      setDebug({ alreadyCollected: true, pageId: page.pageId, url: page.url, groupKey });
      renderDetected();
      return;
    }

    store.seenPageIds[page.pageId] = true;

    store.pages = store.pages.filter((p) => p.pageId !== page.pageId);
    store.pages.push(page);

    const debugRows = [];

    for (const row of rows) {
      const productId = extractProductId(row);
      if (productId) page.stats.rowsWithProductId++;

      const display = extractDisplayText(row);
      const rawCardId = parseCardIdFromDisplay(display);
      if (rawCardId) page.stats.rowsWithRawCardId++;

      const canonicalCardId = rawCardId ? toCanonicalCardId(rawCardId) : null;
      if (canonicalCardId) page.stats.rowsWithCanonicalCardId++;

      const cleanName = cleanDisplayName(display);
      const variantLabel = inferVariantLabelFromName(cleanName);

      debugRows.push({ productId, display, cleanName, variantLabel, rawCardId, canonicalCardId });

      if (!productId || !rawCardId || !canonicalCardId) continue;

      store.entries[canonicalCardId] ??= {
        cardId: canonicalCardId,
        rawCardIds: [],
        ids: { base: [], additional: [] },
        cardmarketProducts: [],
      };

      const entry = store.entries[canonicalCardId];

      if (!entry.rawCardIds.includes(rawCardId)) entry.rawCardIds.push(rawCardId);
      entry.ids[bucket].push(productId);

      entry.cardmarketProducts.push({ productId, name: cleanName, variantLabel, bucket });

      page.stats.rowsPaired++;
    }

    for (const k of Object.keys(store.entries)) {
      const e = store.entries[k];
      e.rawCardIds = Array.from(new Set(e.rawCardIds)).sort();
      e.ids.base = uniqSorted(e.ids.base);
      e.ids.additional = uniqSorted(e.ids.additional);

      const seenProducts = new Set();
      e.cardmarketProducts = (e.cardmarketProducts || []).filter((p) => {
        if (seenProducts.has(p.productId)) return false;
        seenProducts.add(p.productId);
        return true;
      });

      // Cards whose collector number starts with letters (GG, TG, …) never have a
      // reverse-holo print, so "additional" is meaningless for them. Collapse everything
      // into base so the Bulk Edit UI doesn't allocate an empty reverse-holo slot.
      if (/^[A-Z0-9]+-[A-Z]+\d/.test(k)) {
        e.ids.base = uniqSorted([...e.ids.base, ...e.ids.additional]);
        e.ids.additional = [];
        for (const p of e.cardmarketProducts) p.bucket = "base";
      } else {
        // For sets where CM doesn't use a separate Additionals slug (e.g. Surging Sparks),
        // multiple products for the same card all land on the base page with bucket="base".
        // Reclassify the 2nd, 3rd, ... base products as "additional" so they flow through
        // the variant assignment logic in the Bulk Edit UI instead of being silently dropped.
        const baseProducts = e.cardmarketProducts.filter((p) => p.bucket === "base");
        if (baseProducts.length > 1) {
          const primaryId = baseProducts[0].productId;
          for (const p of e.cardmarketProducts) {
            if (p.bucket === "base" && p.productId !== primaryId) {
              p.bucket = "additional";
            }
          }
          e.ids.base = [primaryId];
          e.ids.additional = uniqSorted([
            ...e.ids.additional,
            ...baseProducts.slice(1).map((p) => p.productId),
          ]);
        }
      }
    }

    saveStore(groupKey, store);

    const uniqueKeys = Object.keys(store.entries).length;

    setStatus(
      `Collected ${page.stats.rowsPaired} rows into "${bucket}" (page ${getPageParam()}) under group "${groupKey}". Total merged keys: ${uniqueKeys}.`,
      page.stats.rowsPaired > 0
    );

    setDebug({
      page,
      sampleRows: debugRows.slice(0, 10),
      totals: { mergedKeys: uniqueKeys, pagesCollected: store.pages.length, groupKey },
    });

    renderDetected();

    if (rows.length === 0) {
      setStatus("No product rows detected. Make sure you're on the v2 listing results and scroll once.", false);
    }
  }

  function buildExportPayload() {
    const setSlug = getSetSlugFromUrl();
    const groupKey = resolveGroupKey(setSlug);
    const store = loadStore(groupKey);

    const out = {};
    const keys = Object.keys(store.entries).sort();

    for (const k of keys) {
      const e = store.entries[k];
      out[k] = {
        cardId: e.cardId,
        ids: { base: e.ids.base, additional: e.ids.additional },
        rawCardIds: e.rawCardIds,
        cardmarketProducts: e.cardmarketProducts || [],
      };
    }

    let baseOnly = 0, addOnly = 0, both = 0;
    for (const k of keys) {
      const e = store.entries[k];
      const hasBase = e.ids.base.length > 0;
      const hasAdd = e.ids.additional.length > 0;
      if (hasBase && hasAdd) both++;
      else if (hasBase) baseOnly++;
      else if (hasAdd) addOnly++;
    }

    return {
      meta: {
        tool: "sbf-cm-set-merge-exporter",
        exportedAt: new Date().toISOString(),
        groupKey,
        note: "Keyed by canonical SETCODE-NNN. Cross-slug merge enabled by storing per derived groupKey (canonical set code). Export uses stored setSlug→groupKey index to avoid empty exports. Cardmarket product names and inferred variant labels are included in cardmarketProducts.",
      },
      pages: store.pages,
      stats: { mergedKeys: keys.length, baseOnly, addOnly, both },
      byCardId: out,
    };
  }

  async function exportNow({ download = false } = {}) {
    const setSlug = getSetSlugFromUrl();
    const groupKey = resolveGroupKey(setSlug);
    const payload = buildExportPayload();
    const text = JSON.stringify(payload, null, 2);

    if (download) {
      downloadText(`cardmarket-${groupKey}-merged.json`, text);
      setStatus(`Downloaded merged JSON (${payload.stats.mergedKeys} keys) for "${groupKey}".`, payload.stats.mergedKeys > 0);
    } else {
      await copyText(text);
      setStatus(`Copied merged JSON (${payload.stats.mergedKeys} keys) for "${groupKey}".`, payload.stats.mergedKeys > 0);
    }

    setDebug(payload);

    if (payload.stats.mergedKeys === 0) {
      setStatus(
        `Nothing collected yet for group "${groupKey}". Collect site=1..N for base AND additionals, then Export.`,
        false
      );
    }
  }

  // ===========================================================================
  // Pagination actions
  // ===========================================================================
  function openNextPage() {
    window.location.href = getNextPageUrl();
  }

  function collectAndNext() {
    collectThisPage();
    setTimeout(openNextPage, 250);
  }

  // ===========================================================================
  // Wire up actions
  // ===========================================================================
  $("#sbf-collect").addEventListener("click", collectThisPage);
  $("#sbf-collectNext").addEventListener("click", collectAndNext);
  $("#sbf-next").addEventListener("click", openNextPage);

  $("#sbf-export").addEventListener("click", () => exportNow({ download: false }));
  $("#sbf-download").addEventListener("click", () => exportNow({ download: true }));

  $("#sbf-reset").addEventListener("click", () => {
    const setSlug = getSetSlugFromUrl();
    const groupKey = resolveGroupKey(setSlug);
    clearStore(groupKey);
    setStatus(`Reset complete for group "${groupKey}". Now collect base + additionals site=1..N again.`);
    setDebug({ reset: true, setSlug, groupKey });
    renderDetected();
  });

  // ===========================================================================
  // Migration: merge any SLUG__* stores into their correct group
  // ===========================================================================
  (function migrateSlugStores() {
    try {
      const index = loadGroupIndex();
      const slugEntries = Object.entries(index).filter(([, v]) => v?.groupKey?.startsWith("SLUG__"));
      if (!slugEntries.length) return;

      for (const [slug, entry] of slugEntries) {
        const staleKey = entry.groupKey;
        const staleStore = loadStore(staleKey);
        if (!staleStore.pages.length && !Object.keys(staleStore.entries).length) continue;

        let realKey = null;
        for (const [otherSlug, otherEntry] of Object.entries(index)) {
          if (otherEntry?.groupKey?.startsWith("SLUG__")) continue;
          if (slug.startsWith(otherSlug) || otherSlug.startsWith(slug)) {
            realKey = otherEntry.groupKey;
            break;
          }
        }
        if (!realKey) continue;

        const realStore = loadStore(realKey);
        for (const [cardId, staleEntry] of Object.entries(staleStore.entries)) {
          realStore.entries[cardId] ??= {
            cardId,
            rawCardIds: [],
            ids: { base: [], additional: [] },
            cardmarketProducts: [],
          };
          const target = realStore.entries[cardId];
          target.rawCardIds = Array.from(new Set([...target.rawCardIds, ...(staleEntry.rawCardIds || [])])).sort();
          target.ids.base = uniqSorted([...target.ids.base, ...(staleEntry.ids?.base || [])]);
          target.ids.additional = uniqSorted([...target.ids.additional, ...(staleEntry.ids?.additional || [])]);
          const staleCmProducts = (staleEntry.cardmarketProducts || []).length
            ? staleEntry.cardmarketProducts
            : (staleEntry.sources || [])
                .filter((s) => Number.isFinite(Number(s?.productId)))
                .map((s) => ({ productId: Number(s.productId), name: s.name || "", variantLabel: s.variantLabel || "", bucket: s.bucket || "" }));
          target.cardmarketProducts = [...(target.cardmarketProducts || []), ...staleCmProducts];
        }

        for (const p of staleStore.pages) {
          if (!realStore.pages.some((rp) => rp.pageId === p.pageId)) {
            realStore.pages.push(p);
          }
        }
        Object.assign(realStore.seenPageIds, staleStore.seenPageIds);

        for (const cardId of Object.keys(realStore.entries)) {
          const e = realStore.entries[cardId];
          const seenProducts = new Set();
          e.cardmarketProducts = (e.cardmarketProducts || []).filter((p) => {
            if (seenProducts.has(p.productId)) return false;
            seenProducts.add(p.productId);
            return true;
          });
          delete e.sources;
        }

        saveStore(realKey, realStore);
        clearStore(staleKey);

        index[slug] = { groupKey: realKey, lastSeenAt: new Date().toISOString() };

        console.log(`[SBF Exporter] Migrated SLUG__${slug} → ${realKey} (${Object.keys(staleStore.entries).length} entries)`);
      }
      saveGroupIndex(index);
    } catch (e) {
      console.warn("[SBF Exporter] Migration error:", e);
    }
  })();

  $("#sbf-purge").addEventListener("click", () => {
    pruneAllStores();
    setStatus("Purged old data from all stored sets. localStorage freed.", true);
    renderDetected();
  });

  // ===========================================================================
  // Boot
  // ===========================================================================
  pruneAllStores();
  renderDetected();
  setStatus("Ready. Collect base + additionals (site=1..N) then Export.");
})();
