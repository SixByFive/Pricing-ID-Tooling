import type {
	TCGTrackingSetResponse,
	TCGTrackingSkuResponse,
} from './types'

const API_BASE = 'https://tcgtracking.com/tcgapi/v1'

// Category 3 = Pokémon EN, Category 85 = Pokémon JP
export const CATEGORIES = {
	en: 3,
	ja: 85,
} as const

export type CategoryId = (typeof CATEGORIES)[keyof typeof CATEGORIES]

/**
 * Fetch product-level data for a TCGPlayer set.
 *
 * This gives us:
 * - TCGPlayer product IDs
 * - product names
 * - collector numbers
 * - CardMarket IDs
 * - CardTrader IDs
 *
 * This is still the main source for the thirdParty IDs we write to TCGDex.
 */
export async function fetchSetProducts(
	categoryId: CategoryId,
	tcgplayerSetId: number,
): Promise<TCGTrackingSetResponse> {
	const url = `${API_BASE}/${categoryId}/sets/${tcgplayerSetId}`

	const res = await fetch(url, {
		headers: {
			Accept: 'application/json',
		},
	})

	if (!res.ok) {
		throw new Error(
			`TCGTracking: set ${tcgplayerSetId} returned ${res.status} ${res.statusText}`,
		)
	}

	return res.json() as Promise<TCGTrackingSetResponse>
}

/**
 * Fetch SKU-level data for a TCGPlayer set.
 *
 * This is the important endpoint for variation detection.
 *
 * We use it to identify:
 * - normal
 * - holo
 * - reverse holo
 * - cosmos holo
 * - stamped variants
 * - language-specific SKU data
 * - condition-specific SKU data
 *
 * TCGDex currently stores TCGPlayer product IDs, not SKU IDs, so this function
 * does not mean we write SKU IDs into card files. Instead, the SKU data helps
 * us decide which exact variant should receive the product ID.
 */
export async function fetchSetSkus(
	categoryId: CategoryId,
	tcgplayerSetId: number,
): Promise<TCGTrackingSkuResponse | null> {
	const url = `${API_BASE}/${categoryId}/sets/${tcgplayerSetId}/skus`

	const res = await fetch(url, {
		headers: {
			Accept: 'application/json',
		},
	})

	/**
	 * Some sets may not have SKU data yet.
	 *
	 * In that case, do not fail the entire enrichment run. The tooling can still
	 * fall back to product-level names and CardTrader finish hints.
	 */
	if (res.status === 404) {
		return null
	}

	if (!res.ok) {
		throw new Error(
			`TCGTracking: set ${tcgplayerSetId} SKUs returned ${res.status} ${res.statusText}`,
		)
	}

	return res.json() as Promise<TCGTrackingSkuResponse>
}