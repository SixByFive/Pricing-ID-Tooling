import path from 'node:path'
import { resolveProductVariants } from './variant-resolver'
import type {
	AmbiguousCard,
	CardData,
	MatchedCard,
	MatchResult,
	OrphanProduct,
	TCGTrackingProduct,
	UnmatchedCard,
} from './types'

interface CardEntry {
	filePath: string
	card: CardData
}

/**
 * Matches TCGTracking products to TCGDex card files.
 *
 * Main matching rules:
 *
 * 1. Collector number is the primary match.
 *    Multiple products with the same collector number are expected because
 *    TCGPlayer/TCGTracking may expose separate products for normal, holo,
 *    reverse, stamped, cosmos, Poké Ball, Master Ball, etc.
 *
 * 2. Name matching is fallback only.
 *    Name matches are marked as reviewRequired because names are less safe
 *    than collector numbers.
 *
 * 3. Multiple products are only ambiguous when they resolve to the same
 *    TCGDex variant identity.
 *
 *    Example safe:
 *    - type:normal
 *    - type:holo
 *    - type:reverse
 *
 *    Example ambiguous:
 *    - product A resolves to type:holo
 *    - product B also resolves to type:holo
 *
 *    In that case the writer cannot safely know which ID belongs to the
 *    existing holo variant.
 */
export function matchProductsToCards(
	products: TCGTrackingProduct[],
	cards: CardEntry[],
): { results: MatchResult[]; orphans: OrphanProduct[] } {
	const singleProducts = filterSingleProducts(products)

	const byNumber = buildProductsByNumber(singleProducts)
	const byNumberPadded = buildProductsByNumberPadded(singleProducts)
	const byName = buildProductsByName(singleProducts)

	const matchedProductIds = new Set<number>()
	const results: MatchResult[] = []

	for (const { filePath, card } of cards) {
		const filename = path.basename(filePath, '.ts')
		const existingTcgplayerIds = getExistingTcgplayerIds(card)

		let result: MatchResult

		// -------------------------------------------------------------------
		// Primary match: collector number
		// -------------------------------------------------------------------

		const numberKey = normaliseNumber(filename)
		const paddedKey = paddedNumber(filename)

		// Prefer products whose number matches the file's padded form (e.g. "001/064"
		// matches file "001" exactly). This prevents single-digit energy numbers like
		// "1" from colliding with main-set cards like "001/064" after zero-stripping.
		const paddedMatches = byNumberPadded.get(paddedKey) ?? []
		const allNormMatches = byNumber.get(numberKey) ?? []
		const numberMatches =
			paddedMatches.length > 0
				? allNormMatches.filter((p) => paddedMatches.includes(p))
				: allNormMatches

		if (numberMatches.length >= 1) {
			const filtered = sanityFilter(numberMatches, existingTcgplayerIds)

			for (const product of filtered) {
				matchedProductIds.add(product.id)
			}

			result = buildSafeMatchResult(
				filePath,
				filtered,
				'collector-number',
				false,
			)
		} else {
			// ----------------------------------------------------------------
			// Fallback match: card name
			// ----------------------------------------------------------------

			const cardName = getEnglishName(card.name)
			const nameMatches = cardName
				? sanityFilter(byName.get(normaliseName(cardName)) ?? [], existingTcgplayerIds)
				: []

			if (nameMatches.length >= 1) {
				for (const product of nameMatches) {
					matchedProductIds.add(product.id)
				}

				result = buildSafeMatchResult(
					filePath,
					nameMatches,
					'name-fallback',
					true,
				)
			} else {
				result = unmatched(filePath, existingTcgplayerIds[0])
			}
		}

		results.push(result)
	}

	const orphans: OrphanProduct[] = singleProducts
		.filter((product) => !matchedProductIds.has(product.id))
		.map((product) => ({
			status: 'orphan' as const,
			product,
		}))

	return { results, orphans }
}

// ---------------------------------------------------------------------------
// Match safety
// ---------------------------------------------------------------------------

function buildSafeMatchResult(
	cardFile: string,
	products: TCGTrackingProduct[],
	matchMethod: MatchedCard['matchMethod'],
	reviewRequired: boolean,
): MatchResult {
	if (products.length === 0) {
		return unmatched(cardFile)
	}

	/**
	 * A single product is always safe enough for the writer.
	 */
	if (products.length === 1) {
		return matched(cardFile, products, matchMethod, reviewRequired)
	}

	/**
	 * Multiple products are fine when they resolve to different TCGDex variants.
	 *
	 * Example:
	 * - normal
	 * - holo
	 * - reverse
	 *
	 * This is exactly what we want for cards with multiple finishes.
	 */
	const collisions = findVariantKeyCollisions(products)

	if (collisions.length > 0) {
		return ambiguous(cardFile, products)
	}

	return matched(cardFile, products, matchMethod, reviewRequired)
}

function findVariantKeyCollisions(products: TCGTrackingProduct[]): string[] {
	const counts = new Map<string, number>()

	for (const product of products) {
		const variantMatches = resolveProductVariants(product)

		/**
		 * If the resolver cannot identify anything, use a product-specific key
		 * so we do not create a false collision.
		 *
		 * The writer will still fall back conservatively.
		 */
		if (variantMatches.length === 0) {
			counts.set(`unknown:${product.id}`, 1)
			continue
		}

		for (const variantMatch of variantMatches) {
			counts.set(variantMatch.key, (counts.get(variantMatch.key) ?? 0) + 1)
		}
	}

	return Array.from(counts.entries())
		.filter(([, count]) => count > 1)
		.map(([key]) => key)
}

// ---------------------------------------------------------------------------
// Product lookup builders
// ---------------------------------------------------------------------------

function buildProductsByNumber(
	products: TCGTrackingProduct[],
): Map<string, TCGTrackingProduct[]> {
	const byNumber = new Map<string, TCGTrackingProduct[]>()

	for (const product of products) {
		const numbers = getProductNumbers(product)

		for (const number of numbers) {
			const key = normaliseNumber(number)
			const existing = byNumber.get(key) ?? []

			existing.push(product)
			byNumber.set(key, dedupeProducts(existing))
		}
	}

	return byNumber
}

function buildProductsByNumberPadded(
	products: TCGTrackingProduct[],
): Map<string, TCGTrackingProduct[]> {
	const byNumberPadded = new Map<string, TCGTrackingProduct[]>()

	for (const product of products) {
		const numbers = getProductNumbers(product)

		for (const number of numbers) {
			const key = paddedNumber(number)
			const existing = byNumberPadded.get(key) ?? []

			existing.push(product)
			byNumberPadded.set(key, dedupeProducts(existing))
		}
	}

	return byNumberPadded
}

function buildProductsByName(
	products: TCGTrackingProduct[],
): Map<string, TCGTrackingProduct[]> {
	const byName = new Map<string, TCGTrackingProduct[]>()

	for (const product of products) {
		const names = getProductNames(product)

		for (const name of names) {
			const key = normaliseName(name)
			const existing = byName.get(key) ?? []

			existing.push(product)
			byName.set(key, dedupeProducts(existing))
		}
	}

	return byName
}

function getProductNumbers(product: TCGTrackingProduct): string[] {
	const numbers = new Set<string>()

	if (product.number !== null && product.number !== undefined) {
		numbers.add(product.number)
	}

	for (const cardtraderEntry of product.cardtrader ?? []) {
		if (cardtraderEntry.collector_number) {
			numbers.add(cardtraderEntry.collector_number)
		}
	}

	return Array.from(numbers)
}

function getProductNames(product: TCGTrackingProduct): string[] {
	const names = new Set<string>()

	if (product.name) {
		names.add(product.name)
	}

	/**
	 * clean_name can sometimes include extra set/number noise, so it is only
	 * used as an additional fallback, not as the primary name value.
	 */
	if (product.clean_name) {
		names.add(stripTrailingCollectorNumber(product.clean_name))
	}

	return Array.from(names).filter((name) => name.trim().length > 0)
}

// ---------------------------------------------------------------------------
// Product filtering
// ---------------------------------------------------------------------------

function filterSingleProducts(products: TCGTrackingProduct[]): TCGTrackingProduct[] {
	return products.filter((product) => {
		const cardtraderEntries = product.cardtrader ?? []

		/**
		 * If CardTrader data is missing, keep the product.
		 *
		 * TCGTracking product data can still be valid even when CardTrader does
		 * not have a matching entry.
		 */
		if (cardtraderEntries.length === 0) {
			return true
		}

		/**
		 * Keep products where at least one CardTrader entry says this is a
		 * single card.
		 *
		 * This avoids obvious non-card products while still allowing normal,
		 * holo, reverse, stamped, and special foil variants through.
		 */
		return cardtraderEntries.some((entry) => entry.product_type === 'single')
	})
}

// ---------------------------------------------------------------------------
// Existing ID handling
// ---------------------------------------------------------------------------

function getExistingTcgplayerIds(card: CardData): number[] {
	const ids = new Set<number>()

	if (typeof card.thirdParty?.tcgplayer === 'number') {
		ids.add(card.thirdParty.tcgplayer)
	}

	if (Array.isArray(card.variants)) {
		for (const variant of card.variants) {
			if (
				typeof variant === 'object' &&
				variant !== null &&
				'thirdParty' in variant &&
				typeof variant.thirdParty?.tcgplayer === 'number'
			) {
				ids.add(variant.thirdParty.tcgplayer)
			}
		}
	}

	return Array.from(ids)
}

function sanityFilter(
	products: TCGTrackingProduct[],
	existingTcgplayerIds: number[],
): TCGTrackingProduct[] {
	if (existingTcgplayerIds.length === 0) {
		return products
	}

	/**
	 * If the card already has one or more TCGPlayer IDs and those IDs are in
	 * the candidate list, keep the full candidate list.
	 *
	 * Do not reduce to only the existing product ID, because a card can already
	 * have the normal ID but still need holo/reverse/stamped IDs added.
	 */
	const hasKnownProduct = products.some((product) => {
		return existingTcgplayerIds.includes(product.id)
	})

	return hasKnownProduct ? products : products
}

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

function normaliseNumber(value: string): string {
	const withoutTotal = value.split('/')[0]

	return withoutTotal
		.toLowerCase()
		.trim()
		.replace(/^0+/, '') || '0'
}

// Like normaliseNumber but keeps leading zeros — used to prefer "001/064" over "1"
// when both would normalize to the same value.
function paddedNumber(value: string): string {
	return value.split('/')[0].toLowerCase().trim()
}

function normaliseName(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, '')
		.replace(/\s+/g, ' ')
		.trim()
}

function stripTrailingCollectorNumber(value: string): string {
	return value
		.replace(/\s+\d+\s*\/\s*\d+\s*$/i, '')
		.replace(/\s+\d+\s*$/i, '')
		.trim()
}

function getEnglishName(name?: Record<string, string>): string | undefined {
	return name?.en ?? (name ? Object.values(name)[0] : undefined)
}

function dedupeProducts(products: TCGTrackingProduct[]): TCGTrackingProduct[] {
	const seen = new Set<number>()
	const deduped: TCGTrackingProduct[] = []

	for (const product of products) {
		if (seen.has(product.id)) {
			continue
		}

		seen.add(product.id)
		deduped.push(product)
	}

	return deduped
}

// ---------------------------------------------------------------------------
// Result builders
// ---------------------------------------------------------------------------

function matched(
	cardFile: string,
	products: TCGTrackingProduct[],
	matchMethod: MatchedCard['matchMethod'],
	reviewRequired: boolean,
): MatchedCard {
	return {
		status: 'matched',
		cardFile,
		matchMethod,
		reviewRequired,
		products,
	}
}

function ambiguous(cardFile: string, products: TCGTrackingProduct[]): AmbiguousCard {
	return {
		status: 'ambiguous',
		cardFile,
		products,
	}
}

function unmatched(
	cardFile: string,
	existingTcgplayerId?: number,
): UnmatchedCard {
	return {
		status: 'unmatched',
		cardFile,
		existingTcgplayerId,
	}
}