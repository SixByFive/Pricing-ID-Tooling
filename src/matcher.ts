import path from 'node:path'
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

export function matchProductsToCards(
	products: TCGTrackingProduct[],
	cards: CardEntry[],
): { results: MatchResult[]; orphans: OrphanProduct[] } {
	// Exclude oversized/promotional products (e.g. metal cards) — all cardtrader entries are non-single
	const singleProducts = products.filter((p) => {
		const ct = p.cardtrader ?? []
		return ct.length === 0 || ct.some((entry) => entry.product_type === 'single')
	})

	// Build lookup: normalised collector number → products
	const byNumber = new Map<string, TCGTrackingProduct[]>()

	for (const product of singleProducts) {
		if (product.number !== null) {
			const key = normaliseNumber(product.number)
			const existing = byNumber.get(key) ?? []
			existing.push(product)
			byNumber.set(key, existing)
		}
	}

	// Build lookup: normalised name → products (use name, not clean_name which appends number/total)
	const byName = new Map<string, TCGTrackingProduct[]>()

	for (const product of singleProducts) {
		const key = normaliseName(product.name)
		const existing = byName.get(key) ?? []
		existing.push(product)
		byName.set(key, existing)
	}

	const matchedProductIds = new Set<number>()
	const results: MatchResult[] = []

	for (const { filePath, card } of cards) {
		const filename = path.basename(filePath, '.ts')
		const existingTcgplayerId = card.thirdParty?.tcgplayer
		let result: MatchResult

		// Primary: collector number match
		// ALL products sharing a number belong to this card (different variants) — no ambiguity
		const numberKey = normaliseNumber(filename)
		const numberMatches = byNumber.get(numberKey) ?? []

		if (numberMatches.length >= 1) {
			for (const p of numberMatches) matchedProductIds.add(p.id)
			result = matched(filePath, numberMatches, 'collector-number', false)
		} else {
			// Fallback: name match
			const cardName = getEnglishName(card.name)
			const nameMatches = cardName
				? sanityFilter(byName.get(normaliseName(cardName)) ?? [], existingTcgplayerId)
				: []

			if (nameMatches.length === 1) {
				matchedProductIds.add(nameMatches[0].id)
				result = matched(filePath, nameMatches, 'name-fallback', true)
			} else if (nameMatches.length > 1) {
				for (const p of nameMatches) matchedProductIds.add(p.id)
				result = ambiguous(filePath, nameMatches)
			} else {
				result = unmatched(filePath, existingTcgplayerId)
			}
		}

		results.push(result)
	}

	const orphans: OrphanProduct[] = singleProducts
		.filter((p) => !matchedProductIds.has(p.id))
		.map((product) => ({ status: 'orphan' as const, product }))

	return { results, orphans }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanityFilter(
	products: TCGTrackingProduct[],
	existingTcgplayerId: number | undefined,
): TCGTrackingProduct[] {
	if (typeof existingTcgplayerId !== 'number') {
		return products
	}

	// If the existing product ID is present in the list, keep only it
	const exact = products.filter((p) => p.id === existingTcgplayerId)

	return exact.length > 0 ? exact : products
}

function normaliseNumber(value: string): string {
	// TCGTracking uses "001/165" format — strip /total suffix before stripping leading zeros
	const withoutTotal = value.split('/')[0]
	return withoutTotal.toLowerCase().trim().replace(/^0+/, '') || '0'
}

function normaliseName(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim()
}

function getEnglishName(name?: Record<string, string>): string | undefined {
	return name?.en ?? (name ? Object.values(name)[0] : undefined)
}

function matched(
	cardFile: string,
	products: TCGTrackingProduct[],
	matchMethod: MatchedCard['matchMethod'],
	reviewRequired: boolean,
): MatchedCard {
	return { status: 'matched', cardFile, matchMethod, reviewRequired, products }
}

function ambiguous(cardFile: string, products: TCGTrackingProduct[]): AmbiguousCard {
	return { status: 'ambiguous', cardFile, products }
}

function unmatched(cardFile: string, existingTcgplayerId?: number): UnmatchedCard {
	return { status: 'unmatched', cardFile, existingTcgplayerId }
}
