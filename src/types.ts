import type { CardmarketCardReview } from './cardmarket-merge'

// ---------------------------------------------------------------------------
// TCGTracking API shapes
// ---------------------------------------------------------------------------

export interface TCGTrackingProduct {
	id: number // TCGPlayer product ID
	name: string
	clean_name: string
	number: string | null // collector number, may be null
	rarity: string | null
	cardmarket_id: number | null
	cardtrader_id: number | null
	cardtrader: TCGTrackingCardTraderEntry[]

	/**
	 * Attached by our enrichment step from:
	 * /tcgapi/v1/{categoryId}/sets/{tcgplayerSetId}/skus
	 *
	 * Keyed by TCGPlayer SKU ID.
	 */
	skus?: Record<string, TCGTrackingSkuEntry>

	/**
	 * Added by the enrichment/reporting step.
	 *
	 * This is not source API data. It previews how our resolver maps
	 * TCGTracking product/SKU data to TCGDex's variant model.
	 */
	variantPreview?: VariantPreviewEntry[]
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

	// Extra fields TCGTracking/CardTrader may include.
	name?: string
	match_type?: string
	match_confidence?: number
	expansion?: string
	rarity?: string | null
	languages?: string[]
	properties?: unknown[]
	image_url?: string | null
	scryfall_id?: string | null
	category_name?: string
	group_id?: number
}

export interface TCGTrackingSetResponse {
	set_id: number
	set_name: string
	set_abbr: string
	products: TCGTrackingProduct[]
}

/**
 * Shape returned from TCGTracking's SKU endpoint.
 *
 * The exact source fields may vary slightly as the endpoint evolves, so this
 * intentionally supports several common names:
 *
 * - var / variant / printing / type
 * - cnd / condition
 * - lng / language
 * - mkt / market / marketPrice
 */
export interface TCGTrackingSkuEntry {
	// Condition fields
	cnd?: string
	condition?: string
	conditionName?: string

	// Variation / printing / finish fields
	var?: string
	variant?: string
	printing?: string
	type?: string
	finish?: string
	subtype?: string
	name?: string

	// Language fields
	lng?: string
	language?: string
	languageName?: string

	// Price fields
	mkt?: number
	market?: number
	marketPrice?: number
	low?: number
	lowPrice?: number
	hi?: number
	high?: number
	highPrice?: number

	// Count / stock-like fields
	cnt?: number
	count?: number

	// Allow unknown fields without breaking the tooling when TCGTracking adds more.
	[key: string]: unknown
}

export interface TCGTrackingSkuResponse {
	set_id: number
	updated?: string
	sku_count?: number
	product_count?: number

	/**
	 * Keyed by TCGPlayer product ID, then TCGPlayer SKU ID.
	 */
	products: Record<string, Record<string, TCGTrackingSkuEntry>>
}

// ---------------------------------------------------------------------------
// Variant preview shapes
// ---------------------------------------------------------------------------

export interface VariantPreviewEntry {
	/**
	 * Stable resolver key.
	 *
	 * Examples:
	 * - type:normal
	 * - type:holo
	 * - type:reverse
	 * - type:holo|foil:cosmos
	 * - type:reverse|foil:masterball
	 * - type:holo|stamp:pre-release
	 */
	key: string

	type: CardVariantType
	foil?: CardVariantFoil | string
	stamp?: string[]

	/**
	 * Where the resolver got the variation information from.
	 */
	source: 'sku' | 'cardtrader' | 'product-name'

	/**
	 * Present when the preview came from SKU data.
	 */
	skuId?: string

	/**
	 * Raw SKU variation value.
	 *
	 * Examples:
	 * - N
	 * - H
	 * - RH
	 */
	skuVar?: string

	/**
	 * Useful context for reviewing duplicate SKU rows.
	 */
	condition?: string
	language?: string
}

// ---------------------------------------------------------------------------
// Matching result shapes
// ---------------------------------------------------------------------------

export type MatchMethod = 'collector-number' | 'name-fallback'

export interface MatchedCard {
	status: 'matched'
	cardFile: string
	matchMethod: MatchMethod

	/**
	 * Flag name-matched entries for human review.
	 */
	reviewRequired: boolean

	products: TCGTrackingProduct[]

	/**
	 * Optional CardMarket manual mapping review data.
	 *
	 * Present when the user supplies a CardMarket merge JSON.
	 */
	cardmarketReview?: CardmarketCardReview
}

export interface AmbiguousCard {
	status: 'ambiguous'
	cardFile: string
	products: TCGTrackingProduct[]

	/**
	 * Optional CardMarket manual mapping review data.
	 *
	 * Present when the user supplies a CardMarket merge JSON.
	 */
	cardmarketReview?: CardmarketCardReview
}

export interface UnmatchedCard {
	status: 'unmatched'
	cardFile: string
	existingTcgplayerId?: number

	/**
	 * Optional CardMarket manual mapping review data.
	 *
	 * This is useful when a card was not matched through TCGTracking but still
	 * exists in the CardMarket merge export.
	 */
	cardmarketReview?: CardmarketCardReview
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

	/**
	 * Present when a CardMarket merge export was provided.
	 */
	cardmarket?: {
		exportPath: string
		mappingPath: string
		mergedKeys: number
		baseOnly: number
		addOnly: number
		both: number
	}

	summary: {
		cardFiles: number
		matched: number
		ambiguous: number
		unmatched: number
		orphanProducts: number
		reviewRequired: number
		written: number
		skipped: number

		/**
		 * CardMarket manual mapping summary.
		 *
		 * These stay at 0 when no CardMarket merge JSON is supplied.
		 */
		cardmarketCardsWithReview: number
		cardmarketMappedProducts: number
		cardmarketUnmappedProducts: number
		cardmarketCardsNeedingMapping: number
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

/**
 * TCGDex detailed variant shape.
 *
 * Variants are treated as structured:
 *
 * - type: normal / holo / reverse / etc.
 * - foil: cosmos / pokeball / masterball / etc.
 * - stamp: pre-release / staff / pokemon-center / etc.
 */
export interface CardVariantDetailed {
	type?: CardVariantType
	subtype?: string
	size?: string
	stamp?: string[]
	foil?: CardVariantFoil | string
	thirdParty?: CardThirdParty
}

export type CardVariantType =
	| 'normal'
	| 'holo'
	| 'reverse'
	| 'metal'
	| 'lenticular'

/**
 * Known foil values currently seen/expected in TCGDex-style data.
 *
 * Kept as `| string` on CardVariantDetailed.foil so this tooling does not
 * break when the database gains a new valid foil before this helper is updated.
 */
export type CardVariantFoil =
	| 'cosmos'
	| 'galaxy'
	| 'cracked-ice'
	| 'starlight'
	| 'energy'
	| 'mirror'
	| 'league'
	| 'player-reward'
	| 'professor-program'
	| 'tinsel'
	| 'gold'
	| 'pokeball'
	| 'greatball'
	| 'ultraball'
	| 'masterball'
	| 'loveball'
	| 'friendball'
	| 'quickball'
	| 'duskball'
	| 'team-rocket'

export interface CardData {
	name?: Record<string, string>
	thirdParty?: CardThirdParty
	variants?: CardVariantSimple | CardVariantDetailed[]
}