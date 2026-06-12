import fs from 'node:fs/promises'
import {
	resolveExistingVariant,
	resolveProductVariants,
	variantKey,
	type VariantIdentity,
} from './variant-resolver'
import type { CardmarketCardReview } from './cardmarket-merge'
import type {
	CardVariantDetailed,
	TCGTrackingProduct,
	VariantChange,
} from './types'

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ParsedVariant {
	fields: Array<{ name: string; rawValue: string }>
	thirdParty: Record<string, number>
}

interface ResolvedVariantEntry {
	identity: VariantIdentity
	/**
	 * Preserved from existing detailed variants in the file.
	 * Absent for freshly-generated entries (Mode A or new special CM variants).
	 */
	existingFields?: Array<{ name: string; rawValue: string }>
	existingThirdParty: Record<string, number>
	product?: TCGTrackingProduct
	cardmarketId?: number
}

interface ManualCardmarketMatch {
	key: string
	identity: VariantIdentity
	cardmarketId: number
	/**
	 * When true this mapping can only merge into an existing variant.
	 * Plain variants (type only, no foil/stamp/size) are merge-only because
	 * they are always generated from TCGTracking SKU data and creating a
	 * duplicate plain entry would produce two variants of the same type.
	 */
	mergeOnly: boolean
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BuildVariantsOptions {
	/**
	 * When supplied, the writer uses manual CardMarket mappings as the sole
	 * source of truth for cardmarket IDs. product.cardmarket_id is never used
	 * as a fallback when this is present.
	 */
	cardmarketReview?: CardmarketCardReview
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true if the card source has a parseable `variants` property
 * (an object or array literal). Returns false for cards with no variants
 * property, or with non-object/non-array values like `variants: true`.
 */
export function hasVariants(source: string): boolean {
	return findPropRange(source, 'variants') !== null
}

/**
 * Returns new source with the `variants` property updated in-place.
 *
 * Mode A (simple → detailed): existing variants is a non-array object or absent;
 *   a fresh array is built from TCGTracking products + CardMarket mappings.
 *
 * Mode B (merge into existing): existing variants array is preserved; per-variant
 *   thirdParty IDs are added/updated and new special CM variants are appended.
 *
 * Also removes the top-level `thirdParty` property once IDs live inside variants.
 *
 * Returns source unchanged when no parseable `variants` property is found.
 */
export function buildVariants(
	source: string,
	products: TCGTrackingProduct[],
	options: BuildVariantsOptions = {},
): string {
	const variantsRange = findPropRange(source, 'variants')

	if (!variantsRange) {
		return source
	}

	const propText = source.slice(variantsRange.start, variantsRange.end)
	const isDetailed = /^variants\s*:\s*\[/.test(propText)
	const baseIndent = lineIndent(source, variantsRange.start)
	const hasCardmarketReview = Boolean(options.cardmarketReview)

	const existing = isDetailed ? parseVariantsArray(propText) : []
	const entries = assembleVariantEntries(existing, products, options.cardmarketReview)
	const newPropText = renderEntriesBlock(entries, baseIndent, hasCardmarketReview)

	let nextSource =
		source.slice(0, variantsRange.start) +
		newPropText +
		source.slice(variantsRange.end)

	nextSource = removeTopLevelThirdParty(nextSource)
	nextSource = ensureVariantsLast(nextSource)

	return nextSource === source ? source : nextSource
}

/**
 * Computes what `buildVariants` would change without writing to disk.
 * Returns one VariantChange per variant in the output.
 */
export function computeVariantDiff(
	source: string,
	products: TCGTrackingProduct[],
	options: BuildVariantsOptions = {},
): VariantChange[] {
	const variantsRange = findPropRange(source, 'variants')

	if (!variantsRange) {
		return []
	}

	const propText = source.slice(variantsRange.start, variantsRange.end)
	const isDetailed = /^variants\s*:\s*\[/.test(propText)
	const hasCardmarketReview = Boolean(options.cardmarketReview)

	const existing = isDetailed ? parseVariantsArray(propText) : []
	const entries = assembleVariantEntries(existing, products, options.cardmarketReview)

	return entries.map((entry): VariantChange => {
		const key = variantKey(entry.identity)

		const idsNew = mergeThirdPartyIds(
			entry.existingThirdParty,
			entry.product,
			entry.cardmarketId,
			hasCardmarketReview,
		)

		if (!entry.existingFields) {
			return { key, action: 'add', idsNew, idsAdded: { ...idsNew } }
		}

		const idsAdded: Record<string, number> = {}

		for (const [k, v] of Object.entries(idsNew)) {
			if (entry.existingThirdParty[k] !== v) {
				idsAdded[k] = v
			}
		}

		return {
			key,
			action: Object.keys(idsAdded).length > 0 ? 'update' : 'noop',
			idsNew,
			idsAdded,
		}
	})
}

/**
 * Safe fill mode: adds missing `cardtrader` IDs to existing detailed variants.
 *
 * Rules:
 * - Only operates on detailed (array) variants — never converts simple shape
 * - Only adds `cardtrader` where it is missing and a matched product has it
 * - Never creates new variants
 * - Never removes top-level thirdParty
 * - Never overwrites existing cardmarket, tcgplayer, or cardtrader
 */
export function fillMissingCardtraderIds(
	source: string,
	products: TCGTrackingProduct[],
): string {
	const variantsRange = findPropRange(source, 'variants')

	if (!variantsRange) {
		return source
	}

	const propText = source.slice(variantsRange.start, variantsRange.end)
	const isDetailed = /^variants\s*:\s*\[/.test(propText)

	if (!isDetailed) {
		return source
	}

	const variants = parseVariantsArray(propText)
	const productsByVariantKey = buildProductVariantMap(products)
	const baseIndent = lineIndent(source, variantsRange.start)

	const i1 = baseIndent + '\t'
	const i2 = i1 + '\t'
	const i3 = i2 + '\t'

	let anyChanged = false

	const elements = variants.map((variant) => {
		const existingIdentity = resolveExistingVariant({
			type: getStringField(variant, 'type') as CardVariantDetailed['type'],
			foil: getStringField(variant, 'foil'),
			stamp: getArrayField(variant, 'stamp'),
			size: getStringField(variant, 'size'),
		})

		const key = existingIdentity ? variantKey(existingIdentity) : null

		const product =
			key !== null
				? productsByVariantKey.get(key)
				: products.length === 1 && variants.length === 1
					? products[0]
					: undefined

		const existingCardtrader = variant.thirdParty.cardtrader
		const newCardtrader =
			typeof existingCardtrader !== 'number' && typeof product?.cardtrader_id === 'number'
				? product.cardtrader_id
				: undefined

		if (typeof newCardtrader === 'number') {
			anyChanged = true
		}

		const tp =
			typeof newCardtrader === 'number'
				? { ...variant.thirdParty, cardtrader: newCardtrader }
				: variant.thirdParty

		const lines: string[] = variant.fields.map((field) => {
			return `${i2}${field.name}: ${field.rawValue}`
		})

		if (Object.keys(tp).length > 0) {
			const tpFields = orderedThirdPartyEntries(tp).map(([k, v]) => {
				return `${i3}${k}: ${v}`
			})

			lines.push(`${i2}thirdParty: {\n${tpFields.join(',\n')}\n${i2}}`)
		}

		return `${i1}{\n${lines.join(',\n')}\n${i1}}`
	})

	if (!anyChanged) {
		return source
	}

	const newPropText = `variants: [\n${elements.join(',\n')},\n${baseIndent}],`

	return source.slice(0, variantsRange.start) + newPropText + source.slice(variantsRange.end)
}

// ---------------------------------------------------------------------------
// Core pipeline
// ---------------------------------------------------------------------------

/**
 * Assembles the complete ordered list of variant entries for a card.
 *
 * Mode A (existing is empty):
 *   All entries come from TCGTracking products + CardMarket manual mappings.
 *
 * Mode B (existing is non-empty):
 *   Existing variants are updated with IDs in-place (preserving field order).
 *   New special CM variants (foil/stamp/size) not already present are appended.
 *
 * All entries are sorted together by canonical type order, with special
 * variants grouped immediately after their base type.
 */
function assembleVariantEntries(
	existing: ParsedVariant[],
	products: TCGTrackingProduct[],
	cardmarketReview?: CardmarketCardReview,
): ResolvedVariantEntry[] {
	const productsByVariantKey = buildProductVariantMap(products)
	const entries: ResolvedVariantEntry[] = []
	const coveredKeys = new Set<string>()

	if (existing.length === 0) {
		// ── Mode A: build all entries from TCGTracking products ──────────────
		for (const { identity, product } of products.flatMap(resolveProductVariants)) {
			const key = variantKey(identity)

			if (coveredKeys.has(key)) {
				continue
			}

			entries.push({
				identity,
				existingThirdParty: {},
				product,
				cardmarketId: getCardmarketIdForVariantKey(cardmarketReview, key),
			})

			coveredKeys.add(key)
		}
	} else {
		// ── Mode B: update existing variants, preserve their field order ──────
		for (const variant of existing) {
			const resolvedId = resolveExistingVariant({
				type: getStringField(variant, 'type') as CardVariantDetailed['type'],
				foil: getStringField(variant, 'foil'),
				stamp: getArrayField(variant, 'stamp'),
				size: getStringField(variant, 'size'),
			})

			const key = resolvedId ? variantKey(resolvedId) : null

			if (key) {
				coveredKeys.add(key)
			}

			const identity: VariantIdentity = resolvedId ?? { type: 'normal' }

			const product =
				key !== null
					? productsByVariantKey.get(key)
					: products.length === 1 && existing.length === 1
						? products[0]
						: undefined

			entries.push({
				identity,
				existingFields: variant.fields,
				existingThirdParty: variant.thirdParty,
				product,
				cardmarketId: key !== null
					? getCardmarketIdForVariantKey(cardmarketReview, key)
					: undefined,
			})
		}
	}

	// ── Both modes: apply CM manual mappings ─────────────────────────────────
	for (const manualMatch of buildManualCardmarketMatches(cardmarketReview)) {
		if (coveredKeys.has(manualMatch.key)) {
			continue
		}

		if (manualMatch.mergeOnly) {
			// Plain variants are merge-only: they cannot be created from scratch because
			// TCGTracking is the authoritative source for plain variant existence.
			// However, if an existing entry holds this CM product ID under the WRONG type
			// (e.g. type:normal written previously but user has now mapped it to type:holo),
			// replace that entry fresh so the type corrects itself.
			const conflictIdx = entries.findIndex((e) => {
				const cmId =
					e.cardmarketId ??
					e.existingThirdParty.cardmarket ??
					(typeof e.product?.cardmarket_id === 'number' ? e.product.cardmarket_id : undefined)
				return (
					typeof cmId === 'number' &&
					cmId === manualMatch.cardmarketId &&
					variantKey(e.identity) !== manualMatch.key
				)
			})

			if (conflictIdx !== -1) {
				const old = entries[conflictIdx]
				coveredKeys.delete(variantKey(old.identity))
				// Rebuild without existingFields so the type renders from the corrected identity
				entries[conflictIdx] = {
					identity: manualMatch.identity,
					existingThirdParty: old.existingThirdParty,
					product: old.product ?? productsByVariantKey.get(manualMatch.key),
					cardmarketId: manualMatch.cardmarketId,
				}
				coveredKeys.add(manualMatch.key)
			}
			continue
		}

		entries.push({
			identity: manualMatch.identity,
			existingThirdParty: {},
			product: productsByVariantKey.get(manualMatch.key),
			cardmarketId: manualMatch.cardmarketId,
		})

		coveredKeys.add(manualMatch.key)
	}

	return entries.sort((a, b) => variantSortValue(a.identity) - variantSortValue(b.identity))
}

function renderEntriesBlock(
	entries: ResolvedVariantEntry[],
	baseIndent: string,
	hasCardmarketReview: boolean,
): string {
	const elements = entries.map((entry) => renderEntry(entry, baseIndent, hasCardmarketReview))
	return `variants: [\n${elements.join(',\n')},\n${baseIndent}],`
}

function renderEntry(
	entry: ResolvedVariantEntry,
	baseIndent: string,
	hasCardmarketReview: boolean,
): string {
	const i1 = baseIndent + '\t'
	const i2 = i1 + '\t'
	const i3 = i2 + '\t'

	const tp = mergeThirdPartyIds(
		entry.existingThirdParty,
		entry.product,
		entry.cardmarketId,
		hasCardmarketReview,
	)

	const lines: string[] = []

	if (entry.existingFields) {
		// Mode B: preserve existing field order and raw values
		for (const field of entry.existingFields) {
			lines.push(`${i2}${field.name}: ${field.rawValue}`)
		}
	} else {
		// Mode A / new special variant: generate fields from identity
		lines.push(`${i2}type: '${entry.identity.type}'`)

		if (entry.identity.foil) {
			lines.push(`${i2}foil: '${entry.identity.foil}'`)
		}

		if (entry.identity.size) {
			lines.push(`${i2}size: '${entry.identity.size}'`)
		}

		if (entry.identity.stamp && entry.identity.stamp.length > 0) {
			const stamps = entry.identity.stamp.map((s) => `'${s}'`).join(', ')
			lines.push(`${i2}stamp: [${stamps}]`)
		}
	}

	if (Object.keys(tp).length > 0) {
		const tpFields = orderedThirdPartyEntries(tp).map(([k, v]) => `${i3}${k}: ${v}`)
		lines.push(`${i2}thirdParty: {\n${tpFields.join(',\n')}\n${i2}}`)
	}

	return `${i1}{\n${lines.join(',\n')}\n${i1}}`
}

// ---------------------------------------------------------------------------
// Custom variants array parser (replaces jscodeshift)
//
// Only handles the constrained format used in TCGDex card files:
//   - Object literal arrays with string/number/boolean/array/object values
//   - No template literals, computed properties, or TypeScript type assertions
// ---------------------------------------------------------------------------

function parseVariantsArray(propText: string): ParsedVariant[] {
	const s = propText
		.replace(/^variants\s*:\s*/, '')
		.trimEnd()
		.replace(/,$/, '')
		.trim()

	if (!s.startsWith('[')) {
		return []
	}

	const variants: ParsedVariant[] = []
	let i = 1 // skip [

	while (i < s.length) {
		while (i < s.length && /[\s,]/.test(s[i])) {
			i++
		}

		if (i >= s.length || s[i] === ']') {
			break
		}

		if (s[i] !== '{') {
			i++
			continue
		}

		const end = findBalancedValueEnd(s, i, '{', '}')

		if (end <= i) {
			break
		}

		variants.push(parseVariantObject(s, i, end))
		i = end
	}

	return variants
}

function parseVariantObject(s: string, objStart: number, objEnd: number): ParsedVariant {
	const variant: ParsedVariant = { fields: [], thirdParty: {} }
	let i = objStart + 1 // skip {

	while (i < objEnd - 1) {
		while (i < objEnd && /[\s,]/.test(s[i])) {
			i++
		}

		if (i >= objEnd - 1) {
			break
		}

		// Read property name (unquoted identifier or quoted string)
		let name: string

		if (s[i] === '"' || s[i] === "'") {
			const q = s[i++]
			const ns = i

			while (i < s.length && s[i] !== q) {
				if (s[i] === '\\') i++
				i++
			}

			name = s.slice(ns, i++)
		} else {
			const ns = i

			while (i < s.length && /[a-zA-Z0-9_$]/.test(s[i])) {
				i++
			}

			name = s.slice(ns, i)
		}

		if (!name) {
			i++
			continue
		}

		// Skip whitespace + colon
		while (i < s.length && (s[i] === ' ' || s[i] === '\t')) {
			i++
		}

		if (s[i] !== ':') {
			continue
		}

		i++

		while (i < s.length && (s[i] === ' ' || s[i] === '\t')) {
			i++
		}

		// Read value
		const vs = i
		const ve = readValueEnd(s, i)
		const rawValue = s.slice(vs, ve).trim()
		i = ve

		if (name === 'thirdParty') {
			parseThirdPartyInto(rawValue, variant.thirdParty)
		} else {
			variant.fields.push({ name, rawValue })
		}
	}

	return variant
}

/**
 * Returns the end position (exclusive) of the value starting at `start`.
 * Handles: quoted strings, balanced brackets, and scalars.
 */
function readValueEnd(s: string, start: number): number {
	let i = start
	const c = s[i]

	if (c === '"' || c === "'" || c === '`') {
		const q = c
		i++

		while (i < s.length) {
			if (s[i] === '\\') { i += 2; continue }
			if (s[i] === q) { i++; break }
			i++
		}

		return i
	}

	if (c === '[') return findBalancedValueEnd(s, i, '[', ']')
	if (c === '{') return findBalancedValueEnd(s, i, '{', '}')

	// Scalar: stop at comma, closing bracket, or newline
	while (i < s.length && s[i] !== ',' && s[i] !== '}' && s[i] !== ']' && s[i] !== '\n') {
		i++
	}

	return i
}

function parseThirdPartyInto(rawValue: string, tp: Record<string, number>): void {
	if (!rawValue.startsWith('{')) {
		return
	}

	const inner = rawValue.slice(1, rawValue.lastIndexOf('}')).trim()
	let i = 0

	while (i < inner.length) {
		while (i < inner.length && /[\s,]/.test(inner[i])) {
			i++
		}

		if (i >= inner.length) {
			break
		}

		// Read key
		let key: string

		if (inner[i] === '"' || inner[i] === "'") {
			const q = inner[i++]
			const ks = i

			while (i < inner.length && inner[i] !== q) {
				i++
			}

			key = inner.slice(ks, i++)
		} else {
			const ks = i

			while (i < inner.length && /[a-zA-Z0-9_]/.test(inner[i])) {
				i++
			}

			key = inner.slice(ks, i)
		}

		if (!key) {
			i++
			continue
		}

		// Skip whitespace + colon
		while (i < inner.length && /[\s:]/.test(inner[i])) {
			i++
		}

		// Read integer (thirdParty IDs are always positive integers)
		const ns = i

		if (inner[i] === '-') i++

		while (i < inner.length && /[0-9]/.test(inner[i])) {
			i++
		}

		const numStr = inner.slice(ns, i)

		if (key && numStr) {
			tp[key] = Number(numStr)
		}
	}
}

// ---------------------------------------------------------------------------
// Range finding — top-level card object properties
// ---------------------------------------------------------------------------

function findPropRange(source: string, propName: string): { start: number; end: number } | null {
	const objectRange = findCardObjectRange(source)

	if (!objectRange) {
		return null
	}

	let i = objectRange.open + 1
	let depth = 1
	let inStr = false
	let strChar = ''
	let propStart = -1

	while (i < objectRange.close) {
		const c = source[i]

		if (inStr) {
			if (c === '\\') {
				i++
			} else if (c === strChar) {
				inStr = false
			}

			i++
			continue
		}

		if (c === '"' || c === "'" || c === '`') {
			inStr = true
			strChar = c
			i++
			continue
		}

		if (c === '{' || c === '[' || c === '(') {
			depth++
			i++
			continue
		}

		if (c === '}' || c === ']' || c === ')') {
			depth--
			i++
			continue
		}

		if (depth === 1) {
			const before = source[i - 1]
			const isBoundaryBefore = !before || /[\s,{]/.test(before)

			if (
				isBoundaryBefore &&
				source.startsWith(propName, i) &&
				/[\s:]/.test(source[i + propName.length] ?? '')
			) {
				const colonPos = source.indexOf(':', i)

				if (colonPos === -1 || colonPos > objectRange.close) {
					return null
				}

				propStart = i

				let valueStart = colonPos + 1

				while (source[valueStart] === ' ' || source[valueStart] === '\t') {
					valueStart++
				}

				const valueOpen = source[valueStart]

				let valueEnd: number

				if (valueOpen === '{' || valueOpen === '[') {
					const valueClose = valueOpen === '{' ? '}' : ']'
					valueEnd = findBalancedValueEnd(source, valueStart, valueOpen, valueClose)
					if (valueEnd === -1) return null
				} else if (valueOpen === '"' || valueOpen === "'" || valueOpen === '`') {
					valueEnd = valueStart + 1
					while (valueEnd < source.length) {
						const ch = source[valueEnd]
						if (ch === '\\') { valueEnd += 2; continue }
						if (ch === valueOpen) { valueEnd++; break }
						valueEnd++
					}
				} else {
					// Scalar (number, boolean, null) — read until comma, newline, or closing bracket
					valueEnd = valueStart
					while (valueEnd < source.length) {
						const ch = source[valueEnd]
						if (ch === ',' || ch === '\n' || ch === '}' || ch === ']') break
						valueEnd++
					}
					while (valueEnd > valueStart && (source[valueEnd - 1] === ' ' || source[valueEnd - 1] === '\t')) {
						valueEnd--
					}
				}

				let end = valueEnd

				while (source[end] === ' ' || source[end] === '\t') {
					end++
				}

				if (source[end] === ',') {
					end++
				}

				return { start: propStart, end }
			}
		}

		i++
	}

	return null
}

function findCardObjectRange(source: string): { open: number; close: number } | null {
	const match = source.match(/\bconst\s+card\s*:\s*Card\s*=\s*{/)

	if (!match || match.index === undefined) {
		return null
	}

	const open = source.indexOf('{', match.index)

	if (open === -1) {
		return null
	}

	const close = findBalancedValueEnd(source, open, '{', '}') - 1

	if (close < open) {
		return null
	}

	return { open, close }
}

function findBalancedValueEnd(
	source: string,
	openPos: number,
	open: string,
	close: string,
): number {
	let depth = 0
	let i = openPos
	let inStr = false
	let strChar = ''

	while (i < source.length) {
		const c = source[i]

		if (inStr) {
			if (c === '\\') {
				i++
			} else if (c === strChar) {
				inStr = false
			}
		} else {
			if (c === '"' || c === "'" || c === '`') {
				inStr = true
				strChar = c
			} else if (c === open) {
				depth++
			} else if (c === close) {
				depth--

				if (depth === 0) {
					return i + 1
				}
			}
		}

		i++
	}

	return -1
}

/**
 * Removes the top-level `thirdParty` property from the card object.
 *
 * Safety: `findPropRange` only matches properties at depth 1 of the card object.
 * The `thirdParty` entries nested inside individual variants sit at depth 3+
 * (card object → variants array → variant object → thirdParty) and are never
 * reached by this scan.
 */
export function ensureVariantsLast(source: string): string {
	const variantsRange = findPropRange(source, 'variants')
	if (!variantsRange) return source

	const objectRange = findCardObjectRange(source)
	if (!objectRange) return source

	// Extract the full variants line (leading indent through trailing newline)
	let blockStart = variantsRange.start
	while (blockStart > 0 && source[blockStart - 1] !== '\n') {
		blockStart--
	}

	let blockEnd = variantsRange.end
	if (source[blockEnd] === '\n') blockEnd++

	const variantsBlock = source.slice(blockStart, blockEnd)
	let withoutVariants = source.slice(0, blockStart) + source.slice(blockEnd)

	// Find insertion point: start of the closing brace line
	const newClose = objectRange.close - (blockEnd - blockStart)
	let insertPos = newClose
	while (insertPos > 0 && withoutVariants[insertPos - 1] !== '\n') {
		insertPos--
	}

	// Ensure the property before the insertion point ends with a comma
	let lastNonWs = insertPos - 1
	while (lastNonWs >= 0 && /\s/.test(withoutVariants[lastNonWs])) {
		lastNonWs--
	}
	if (lastNonWs >= 0 && withoutVariants[lastNonWs] !== ',') {
		withoutVariants =
			withoutVariants.slice(0, lastNonWs + 1) + ',' + withoutVariants.slice(lastNonWs + 1)
		insertPos++
	}

	// Ensure a blank line between the last property and variants
	const hasBlankLine =
		withoutVariants[insertPos - 1] === '\n' &&
		insertPos >= 2 &&
		withoutVariants[insertPos - 2] === '\n'
	const gap = hasBlankLine ? '' : '\n'

	const result =
		withoutVariants.slice(0, insertPos) + gap + variantsBlock + withoutVariants.slice(insertPos)

	return result === source ? source : result
}

function removeTopLevelThirdParty(source: string): string {
	const range = findPropRange(source, 'thirdParty')

	if (!range) {
		return source
	}

	let start = range.start
	let end = range.end

	// Trim surrounding blank lines neatly.
	while (source[start - 1] === '\n' && source[start - 2] === '\n') {
		start--
	}

	while (source[end] === '\n' && source[end + 1] === '\n') {
		end++
	}

	return source.slice(0, start) + source.slice(end)
}

// ---------------------------------------------------------------------------
// CardMarket helpers
// ---------------------------------------------------------------------------

function getCardmarketIdForVariantKey(
	cardmarketReview: CardmarketCardReview | undefined,
	key: string,
): number | undefined {
	if (!cardmarketReview) {
		return undefined
	}

	for (const product of cardmarketReview.products) {
		if (!product.mapping) {
			continue
		}

		const productKey = variantKey({
			type: product.mapping.type,
			foil: product.mapping.foil,
			size: product.mapping.size,
			stamp: product.mapping.stamp,
		})

		if (productKey === key) {
			return product.productId
		}
	}

	/**
	 * Reverse holos share the base CardMarket product listing with normal.
	 * On CardMarket, normal and reverse are the same product — just different
	 * conditions within it.
	 *
	 * Holo and other types are separate CardMarket products and must NOT fall
	 * back to the base product ID.
	 */
	if (key === 'type:reverse') {
		return getBaseCardmarketId(cardmarketReview)
	}

	return undefined
}

/** Returns the CardMarket product ID for the base (auto-mapped) product, if any. */
function getBaseCardmarketId(cardmarketReview: CardmarketCardReview): number | undefined {
	return cardmarketReview.products.find((p) => p.bucket === 'base')?.productId
}

function buildManualCardmarketMatches(
	cardmarketReview?: CardmarketCardReview,
): ManualCardmarketMatch[] {
	if (!cardmarketReview) {
		return []
	}

	const matches: ManualCardmarketMatch[] = []

	for (const product of cardmarketReview.products) {
		if (!product.mapping) {
			continue
		}

		const isPlain =
			!product.mapping.foil &&
			!product.mapping.size &&
			(!product.mapping.stamp || product.mapping.stamp.length === 0)

		const identity: VariantIdentity = {
			type: product.mapping.type,
			foil: product.mapping.foil,
			size: product.mapping.size,
			stamp: product.mapping.stamp,
		}

		matches.push({
			key: variantKey(identity),
			identity,
			cardmarketId: product.productId,
			mergeOnly: isPlain,
		})
	}

	return matches
}

// ---------------------------------------------------------------------------
// Third-party ID helpers
// ---------------------------------------------------------------------------

/**
 * Merges existing third-party IDs with new ones from a product + cardmarket mapping.
 *
 * When `hasCardmarketReview` is true, product.cardmarket_id is never used as
 * a fallback — manual CardMarket mappings are the sole source of truth.
 */
function mergeThirdPartyIds(
	existing: Record<string, number>,
	product?: TCGTrackingProduct,
	cardmarketId?: number,
	hasCardmarketReview = false,
): Record<string, number> {
	const merged = { ...existing }

	if (typeof cardmarketId === 'number') {
		merged.cardmarket = cardmarketId
	} else if (!hasCardmarketReview && typeof product?.cardmarket_id === 'number') {
		merged.cardmarket ??= product.cardmarket_id
	}

	if (product) {
		merged.tcgplayer ??= product.id
	}

	return merged
}

// ---------------------------------------------------------------------------
// thirdParty ordering
// ---------------------------------------------------------------------------

const TP_CANONICAL_ORDER = ['cardmarket', 'tcgplayer', 'cardtrader']

function orderedThirdPartyEntries(tp: Record<string, number>): Array<[string, number]> {
	return (Object.entries(tp) as Array<[string, number]>).sort(([a], [b]) => {
		const ai = TP_CANONICAL_ORDER.indexOf(a)
		const bi = TP_CANONICAL_ORDER.indexOf(b)
		return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
	})
}

// ---------------------------------------------------------------------------
// Variant sort order
// ---------------------------------------------------------------------------

/**
 * Canonical sort order: normal → holo → reverse → metal → lenticular.
 *
 * Special variants (foil/stamp/size) sort immediately after their base type
 * so related variants stay grouped.
 *
 *   normal (100) → normal+special (150) →
 *   holo (200)   → holo+special (250)   →
 *   reverse (300) → reverse+special (350) → ...
 */
function variantSortValue(identity: VariantIdentity): number {
	const isSpecial = Boolean(
		identity.foil ||
		(identity.stamp && identity.stamp.length > 0) ||
		(identity.size && identity.size !== 'standard'),
	)

	const base = (() => {
		switch (identity.type) {
			case 'normal': return 100
			case 'holo': return 200
			case 'reverse': return 300
			case 'metal': return 400
			case 'lenticular': return 500
			default: return 900
		}
	})()

	return base + (isSpecial ? 50 : 0)
}

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

function buildProductVariantMap(products: TCGTrackingProduct[]): Map<string, TCGTrackingProduct> {
	const map = new Map<string, TCGTrackingProduct>()

	for (const product of products) {
		for (const match of resolveProductVariants(product)) {
			if (!map.has(match.key)) {
				map.set(match.key, product)
			}
		}
	}

	return map
}

function getStringField(variant: ParsedVariant, fieldName: string): string | undefined {
	const field = variant.fields.find((entry) => entry.name === fieldName)

	if (!field) {
		return undefined
	}

	return field.rawValue.replace(/^['"`]|['"`]$/g, '')
}

function getArrayField(variant: ParsedVariant, fieldName: string): string[] | undefined {
	const field = variant.fields.find((entry) => entry.name === fieldName)

	if (!field) {
		return undefined
	}

	const matches = Array.from(field.rawValue.matchAll(/['"`]([^'"`]+)['"`]/g))

	return matches.map((match) => match[1])
}

function lineIndent(source: string, pos: number): string {
	const lineStart = source.lastIndexOf('\n', pos - 1) + 1
	const match = source.slice(lineStart, pos).match(/^(\s+)/)
	return match ? match[1] : '\t'
}

function ensureNewlineAtEof(source: string): string {
	return source.endsWith('\n') ? source : `${source}\n`
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

export async function writeCardFile(filePath: string, source: string): Promise<void> {
	await fs.writeFile(filePath, ensureNewlineAtEof(source), 'utf8')
}

// ---------------------------------------------------------------------------
// Backwards-compatible export
// ---------------------------------------------------------------------------

/**
 * @deprecated Use resolveProductVariants from variant-resolver.ts instead.
 */
export function normaliseFinish(product: TCGTrackingProduct): string | null {
	const match = resolveProductVariants(product)[0]

	if (!match) {
		return null
	}

	if (match.identity.foil) {
		return `${match.identity.type}:${match.identity.foil}`
	}

	if (match.identity.size) {
		return `${match.identity.type}:${match.identity.size}`
	}

	if (match.identity.stamp && match.identity.stamp.length > 0) {
		return `${match.identity.type}:${match.identity.stamp.join('+')}`
	}

	return match.identity.type
}
