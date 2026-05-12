import fs from 'node:fs/promises'
import jscodeshift from 'jscodeshift'
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
} from './types'

const j = jscodeshift.withParser('ts')

type BNode = { type: string; [k: string]: any }

interface ParsedVariant {
	fields: Array<{ name: string; rawValue: string }>
	thirdParty: Record<string, number>
}

export interface BuildVariantsOptions {
	/**
	 * Optional CardMarket review data attached during enrichment.
	 *
	 * When supplied, this lets the writer use the manual CardMarket mappings:
	 *
	 * type:normal              -> cardmarket base ID
	 * type:holo                -> cardmarket base ID for holo-only cards
	 * type:holo|foil:cosmos    -> cardmarket additional ID
	 * type:holo|stamp:...      -> cardmarket additional ID
	 * type:holo|size:jumbo     -> cardmarket additional ID
	 */
	cardmarketReview?: CardmarketCardReview
}

/**
 * Returns new source with the `variants` property updated.
 *
 * It also removes top-level `thirdParty` when variants become detailed,
 * because the IDs now belong inside each variant.
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

	let newPropText: string

	if (isDetailed) {
		const variants = parseVariantsArray(propText)

		newPropText = renderVariantsBlock(
			variants,
			products,
			baseIndent,
			options.cardmarketReview,
		)
	} else {
		newPropText = buildFreshVariantsBlock(
			products,
			baseIndent,
			options.cardmarketReview,
		)
	}

	let nextSource =
		source.slice(0, variantsRange.start) +
		newPropText +
		source.slice(variantsRange.end)

	/**
	 * Remove old top-level thirdParty once variants have per-variant thirdParty.
	 *
	 * Important:
	 * This only removes the card-level thirdParty property, not nested
	 * variant.thirdParty objects.
	 */
	nextSource = removeTopLevelThirdParty(nextSource)

	return nextSource === source ? source : nextSource
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
				const valueClose =
					valueOpen === '{' ? '}'
						: valueOpen === '[' ? ']'
							: null

				if (!valueClose) {
					return null
				}

				const valueEnd = findBalancedValueEnd(source, valueStart, valueOpen, valueClose)

				if (valueEnd === -1) {
					return null
				}

				let end = valueEnd

				while (source[end] === ' ' || source[end] === '\t') {
					end++
				}

				if (source[end] === ',') {
					end++
				}

				return {
					start: propStart,
					end,
				}
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

	return {
		open,
		close,
	}
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

function removeTopLevelThirdParty(source: string): string {
	const range = findPropRange(source, 'thirdParty')

	if (!range) {
		return source
	}

	let start = range.start
	let end = range.end

	/**
	 * Trim surrounding blank lines neatly.
	 */
	while (source[start - 1] === '\n' && source[start - 2] === '\n') {
		start--
	}

	while (source[end] === '\n' && source[end + 1] === '\n') {
		end++
	}

	return source.slice(0, start) + source.slice(end)
}

// ---------------------------------------------------------------------------
// Parse existing detailed variants array into structured data
// ---------------------------------------------------------------------------

function parseVariantsArray(propText: string): ParsedVariant[] {
	const arrayText = propText.replace(/^variants\s*:\s*/, '')
	const wrapper = `const __v = ${arrayText}`
	const root = j(wrapper)

	const variants: ParsedVariant[] = []

	root.find(j.VariableDeclarator).forEach((p) => {
		const init = p.node.init as BNode

		if (init.type !== 'ArrayExpression') {
			return
		}

		for (const el of init.elements as BNode[]) {
			if (!el || el.type !== 'ObjectExpression') {
				continue
			}

			const variant: ParsedVariant = {
				fields: [],
				thirdParty: {},
			}

			for (const prop of el.properties as BNode[]) {
				const name: string = prop.key?.name ?? prop.key?.value ?? ''

				if (!name) {
					continue
				}

				if (name === 'thirdParty') {
					for (const tp of (prop.value?.properties ?? []) as BNode[]) {
						const key: string = tp.key?.name ?? tp.key?.value ?? ''
						const value = tp.value?.value

						if (key && typeof value === 'number') {
							variant.thirdParty[key] = value
						}
					}
				} else {
					variant.fields.push({
						name,
						rawValue: rawValueOf(prop.value),
					})
				}
			}

			variants.push(variant)
		}
	})

	return variants
}

function rawValueOf(node: BNode): string {
	if (!node) {
		return 'undefined'
	}

	switch (node.type) {
		case 'StringLiteral':
			return `'${node.value}'`

		case 'NumericLiteral':
			return String(node.value)

		case 'BooleanLiteral':
			return String(node.value)

		case 'NullLiteral':
			return 'null'

		case 'ArrayExpression':
			return `[${(node.elements as BNode[]).map(rawValueOf).join(', ')}]`

		case 'ObjectExpression': {
			const pairs = (node.properties as BNode[]).map((p) => {
				const key = p.key?.name ?? p.key?.value

				return `${key}: ${rawValueOf(p.value)}`
			})

			return `{ ${pairs.join(', ')} }`
		}

		default:
			return 'undefined'
	}
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

function renderVariantsBlock(
	variants: ParsedVariant[],
	products: TCGTrackingProduct[],
	baseIndent: string,
	cardmarketReview?: CardmarketCardReview,
): string {
	const productsByVariantKey = buildProductVariantMap(products)

	const i1 = baseIndent + '\t'
	const i2 = i1 + '\t'
	const i3 = i2 + '\t'

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

		const cardmarketId =
			key !== null
				? getCardmarketIdForVariantKey(cardmarketReview, key)
				: undefined

		const merged = mergeThirdParty(variant.thirdParty, product, cardmarketId)

		const lines: string[] = variant.fields.map((field) => {
			return `${i2}${field.name}: ${field.rawValue}`
		})

		if (Object.keys(merged).length > 0) {
			const tpFields = Object.entries(merged).map(([k, v]) => {
				return `${i3}${k}: ${v}`
			})

			lines.push(`${i2}thirdParty: {\n${tpFields.join(',\n')}\n${i2}}`)
		}

		return `${i1}{\n${lines.join(',\n')}\n${i1}}`
	})

	return `variants: [\n${elements.join(',\n')},\n${baseIndent}],`
}

function buildFreshVariantsBlock(
	products: TCGTrackingProduct[],
	baseIndent: string,
	cardmarketReview?: CardmarketCardReview,
): string {
	const i1 = baseIndent + '\t'
	const i2 = i1 + '\t'
	const i3 = i2 + '\t'

	const mergedMatches = buildMergedVariantMatches(products, cardmarketReview)

	const elements = mergedMatches.map((match) => {
		const lines: string[] = []

		lines.push(`${i2}type: '${match.identity.type}'`)

		if (match.identity.foil) {
			lines.push(`${i2}foil: '${match.identity.foil}'`)
		}

		if (match.identity.size) {
			lines.push(`${i2}size: '${match.identity.size}'`)
		}

		if (match.identity.stamp && match.identity.stamp.length > 0) {
			const stamps = match.identity.stamp.map((stamp) => `'${stamp}'`).join(', ')
			lines.push(`${i2}stamp: [${stamps}]`)
		}

		const tp = buildThirdPartyFields(
			match.product,
			i3,
			match.cardmarketId,
		)

		if (tp.length > 0) {
			lines.push(`${i2}thirdParty: {\n${tp.join(',\n')}\n${i2}}`)
		}

		return `${i1}{\n${lines.join(',\n')}\n${i1}}`
	})

	return `variants: [\n${elements.join(',\n')},\n${baseIndent}],`
}

interface MergedVariantMatch {
	key: string
	identity: VariantIdentity
	product?: TCGTrackingProduct
	cardmarketId?: number
}

function buildMergedVariantMatches(
	products: TCGTrackingProduct[],
	cardmarketReview?: CardmarketCardReview,
): MergedVariantMatch[] {
	const byKey = new Map<string, MergedVariantMatch>()

	for (const match of products.flatMap(resolveProductVariants)) {
		const key = variantKey(match.identity)

		if (!byKey.has(key)) {
			byKey.set(key, {
				key,
				identity: match.identity,
				product: match.product,
				cardmarketId: getCardmarketIdForVariantKey(cardmarketReview, key),
			})
		}
	}

	for (const manualMatch of buildManualCardmarketMatches(cardmarketReview)) {
		const existing = byKey.get(manualMatch.key)

		if (existing) {
			existing.cardmarketId = manualMatch.cardmarketId
			continue
		}

		byKey.set(manualMatch.key, manualMatch)
	}

	return Array.from(byKey.values()).sort((a, b) => {
		return variantSortValue(a.identity) - variantSortValue(b.identity)
	})
}

function buildProductVariantMap(products: TCGTrackingProduct[]): Map<string, TCGTrackingProduct> {
	const map = new Map<string, TCGTrackingProduct>()

	for (const product of products) {
		for (const match of resolveProductVariants(product)) {
			const key = variantKey(match.identity)

			if (!map.has(key)) {
				map.set(key, product)
			}
		}
	}

	return map
}

function mergeThirdParty(
	existing: Record<string, number>,
	product?: TCGTrackingProduct,
	cardmarketId?: number,
): Record<string, number> {
	const merged = { ...existing }

	if (typeof cardmarketId === 'number') {
		merged.cardmarket = cardmarketId
	} else if (typeof product?.cardmarket_id === 'number') {
		merged.cardmarket ??= product.cardmarket_id
	}

	if (product) {
		merged.tcgplayer ??= product.id

		if (typeof product.cardtrader_id === 'number') {
			merged.cardtrader ??= product.cardtrader_id
		}
	}

	return merged
}

function buildThirdPartyFields(
	product: TCGTrackingProduct | undefined,
	indent: string,
	cardmarketId?: number,
): string[] {
	const lines: string[] = []

	if (typeof cardmarketId === 'number') {
		lines.push(`${indent}cardmarket: ${cardmarketId}`)
	} else if (typeof product?.cardmarket_id === 'number') {
		lines.push(`${indent}cardmarket: ${product.cardmarket_id}`)
	}

	if (product) {
		lines.push(`${indent}tcgplayer: ${product.id}`)

		if (typeof product.cardtrader_id === 'number') {
			lines.push(`${indent}cardtrader: ${product.cardtrader_id}`)
		}
	}

	return lines
}

// ---------------------------------------------------------------------------
// CardMarket manual mapping helpers
// ---------------------------------------------------------------------------

function buildManualCardmarketMatches(
	cardmarketReview?: CardmarketCardReview,
): MergedVariantMatch[] {
	if (!cardmarketReview) {
		return []
	}

	const matches: MergedVariantMatch[] = []

	for (const product of cardmarketReview.products) {
		if (!product.mapping) {
			continue
		}

		/**
		 * Important:
		 * Base CardMarket rows should only merge into existing/generated variants.
		 * They should NOT create new standalone variants.
		 *
		 * Additional rows are different: they represent extra real variants like
		 * cosmos holo, stamped holo, jumbo, etc., so they may create a new variant.
		 */
		if (product.bucket !== 'additional') {
			continue
		}

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
		})
	}

	return matches
}

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

	return undefined
}

// ---------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------

function getStringField(variant: ParsedVariant, fieldName: string): string | undefined {
	const field = variant.fields.find((entry) => entry.name === fieldName)

	if (!field) {
		return undefined
	}

	return field.rawValue.replace(/^['"]|['"]$/g, '')
}

function getArrayField(variant: ParsedVariant, fieldName: string): string[] | undefined {
	const field = variant.fields.find((entry) => entry.name === fieldName)

	if (!field) {
		return undefined
	}

	const matches = Array.from(field.rawValue.matchAll(/['"]([^'"]+)['"]/g))

	return matches.map((match) => match[1])
}

function variantSortValue(identity: VariantIdentity): number {
	switch (identity.type) {
		case 'normal':
			return 10
		case 'holo':
			return 20
		case 'reverse':
			return 30
		case 'metal':
			return 40
		case 'lenticular':
			return 50
		default:
			return 99
	}
}

function lineIndent(source: string, pos: number): string {
	const lineStart = source.lastIndexOf('\n', pos - 1) + 1
	const match = source.slice(lineStart, pos).match(/^(\s+)/)

	return match ? match[1] : '\t'
}

/**
 * Kept for backwards compatibility with any existing imports.
 *
 * New code should use `resolveProductVariants()` from `variant-resolver.ts`,
 * because a product can now represent more than one useful variant depending
 * on SKU data.
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

export async function writeCardFile(filePath: string, source: string): Promise<void> {
	await fs.writeFile(filePath, ensureNewlineAtEof(source), 'utf8')
}

function ensureNewlineAtEof(source: string): string {
	return source.endsWith('\n') ? source : `${source}\n`
}