import type { TCGTrackingSetResponse } from './types'

const API_BASE = 'https://tcgtracking.com/tcgapi/v1'

// Category 3 = Pokémon EN, Category 85 = Pokémon JP
export const CATEGORIES = { en: 3, ja: 85 } as const
export type CategoryId = (typeof CATEGORIES)[keyof typeof CATEGORIES]

export async function fetchSetProducts(
	categoryId: CategoryId,
	tcgplayerSetId: number,
): Promise<TCGTrackingSetResponse> {
	const url = `${API_BASE}/${categoryId}/sets/${tcgplayerSetId}`
	const res = await fetch(url, { headers: { Accept: 'application/json' } })

	if (!res.ok) {
		throw new Error(
			`TCGTracking: set ${tcgplayerSetId} returned ${res.status} ${res.statusText}`,
		)
	}

	return res.json() as Promise<TCGTrackingSetResponse>
}
