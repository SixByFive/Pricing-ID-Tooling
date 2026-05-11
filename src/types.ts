// ---------------------------------------------------------------------------
// TCGTracking API shapes
// ---------------------------------------------------------------------------

export interface TCGTrackingProduct {
	id: number             // TCGPlayer product ID
	name: string
	clean_name: string
	number: string | null  // collector number, may be null
	rarity: string | null
	cardmarket_id: number | null
	cardtrader_id: number | null
	cardtrader: TCGTrackingCardTraderEntry[]
}

export interface TCGTrackingCardTraderEntry {
	id: number
	expansion_code: string
	collector_number: string | null
	finishes: string[]
	cardmarket_ids: number[]
	tcg_player_id: number
	game_id: number
	category_id: number
	product_type: string
}

export interface TCGTrackingSetResponse {
	set_id: number
	set_name: string
	set_abbr: string
	products: TCGTrackingProduct[]
}

// ---------------------------------------------------------------------------
// Matching result shapes
// ---------------------------------------------------------------------------

export type MatchMethod = 'collector-number' | 'name-fallback'

export interface MatchedCard {
	status: 'matched'
	cardFile: string
	matchMethod: MatchMethod
	/** Flag name-matched entries for human review */
	reviewRequired: boolean
	products: TCGTrackingProduct[]
}

export interface AmbiguousCard {
	status: 'ambiguous'
	cardFile: string
	products: TCGTrackingProduct[]
}

export interface UnmatchedCard {
	status: 'unmatched'
	cardFile: string
	existingTcgplayerId?: number
}

export interface OrphanProduct {
	status: 'orphan'
	product: TCGTrackingProduct
}

export type MatchResult =
	| MatchedCard
	| AmbiguousCard
	| UnmatchedCard

// ---------------------------------------------------------------------------
// Report shapes
// ---------------------------------------------------------------------------

export interface EnrichmentReport {
	createdAt: string
	repo: string
	set: string
	mode: 'dry-run' | 'apply'
	summary: {
		cardFiles: number
		matched: number
		ambiguous: number
		unmatched: number
		orphanProducts: number
		reviewRequired: number
		written: number
		skipped: number
	}
	matched: MatchedCard[]
	ambiguous: AmbiguousCard[]
	unmatched: UnmatchedCard[]
	orphanProducts: OrphanProduct[]
}

// ---------------------------------------------------------------------------
// Card file shapes (subset of TCGDex card format)
// ---------------------------------------------------------------------------

export interface CardThirdParty {
	tcgplayer?: number
	cardmarket?: number
	cardtrader?: number
}

export interface CardVariantSimple {
	[finishKey: string]: boolean
}

export interface CardVariantDetailed {
	type?: string
	subtype?: string
	size?: string
	stamp?: string[]
	foil?: string
	thirdParty?: CardThirdParty
}

export interface CardData {
	name?: Record<string, string>
	thirdParty?: CardThirdParty
	variants?: CardVariantSimple | CardVariantDetailed[]
}
