import type {
	CardVariantDetailed,
	CardVariantType,
	TCGTrackingProduct,
	TCGTrackingSkuEntry,
} from './types'

export interface VariantIdentity {
	type: CardVariantType
	foil?: string
	stamp?: string[]
	size?: string
}

export interface ProductVariantMatch {
	/**
	 * Stable comparable key.
	 *
	 * Example:
	 * type:holo
	 * type:reverse
	 * type:holo|foil:cosmos
	 * type:reverse|foil:masterball
	 * type:holo|stamp:pre-release
	 * type:holo|size:jumbo
	 */
	key: string

	/**
	 * TCGDex-style variant identity.
	 */
	identity: VariantIdentity

	/**
	 * Source TCGTracking product.
	 */
	product: TCGTrackingProduct

	/**
	 * Optional TCGPlayer SKU ID.
	 *
	 * We currently do not write this into card files because TCGDex stores
	 * product IDs in thirdParty.tcgplayer, not SKU IDs.
	 */
	skuId?: string

	/**
	 * Optional SKU data used to resolve the variation.
	 */
	sku?: TCGTrackingSkuEntry
}

/**
 * Build all possible TCGDex-style variant identities for a TCGTracking product.
 *
 * Priority:
 * 1. SKU data from /skus
 * 2. CardTrader finish hints
 * 3. Product name fallback
 */
export function resolveProductVariants(product: TCGTrackingProduct): ProductVariantMatch[] {
	const skuMatches = resolveSkuVariants(product)

	if (skuMatches.length > 0) {
		return dedupeMatches(skuMatches)
	}

	const cardTraderMatches = resolveCardTraderVariants(product)

	if (cardTraderMatches.length > 0) {
		return dedupeMatches(cardTraderMatches)
	}

	const fallback = resolveFromText([
		product.name,
		product.clean_name,
	])

	return fallback
		? [
				{
					key: variantKey(fallback),
					identity: fallback,
					product,
				},
			]
		: []
}

/**
 * Converts an existing card variant from the card file into the same identity
 * format as TCGTracking-derived products.
 */
export function resolveExistingVariant(
	variant: Pick<CardVariantDetailed, 'type' | 'foil' | 'stamp' | 'size'>,
): VariantIdentity | null {
	if (!variant.type) {
		return null
	}

	const stamp = normaliseStampList(variant.stamp)
	const size = normaliseSize(variant.size)

	return {
		type: variant.type,
		foil: variant.foil,
		size,
		stamp: stamp.length > 0 ? stamp : undefined,
	}
}

/**
 * Builds a stable key for matching a TCGTracking-derived product variation
 * against an existing TCGDex card variant.
 */
export function variantKey(identity: VariantIdentity): string {
	const parts = [`type:${identity.type}`]

	if (identity.foil) {
		parts.push(`foil:${identity.foil}`)
	}

	if (identity.size && identity.size !== 'standard') {
		parts.push(`size:${identity.size}`)
	}

	const stamps = normaliseStampList(identity.stamp)

	if (stamps.length > 0) {
		parts.push(`stamp:${stamps.join('+')}`)
	}

	return parts.join('|')
}

/**
 * Resolve a variant identity from any collection of text fields.
 *
 * This is intentionally defensive because variation data can appear in:
 * - SKU variant/type/finish fields
 * - CardTrader finish fields
 * - product names
 * - clean names
 */
export function resolveFromText(values: Array<string | null | undefined>): VariantIdentity | null {
	const text = normaliseSearchText(values)

	if (!text) {
		return null
	}

	const stamp = resolveStamps(text)
	const foil = resolveFoil(text)
	const size = resolveSize(text)
	const type = resolveVariantType(text, foil)

	return {
		type,
		foil,
		size,
		stamp: stamp.length > 0 ? stamp : undefined,
	}
}

// ---------------------------------------------------------------------------
// SKU/CardTrader extraction
// ---------------------------------------------------------------------------

function resolveSkuVariants(product: TCGTrackingProduct): ProductVariantMatch[] {
	const matches: ProductVariantMatch[] = []

	if (!product.skus) {
		return matches
	}

	for (const [skuId, sku] of Object.entries(product.skus)) {
		const identity =
			resolveFromSkuVar(readString(sku.var)) ??
			resolveFromSkuVar(readString(sku.variant)) ??
			resolveFromSkuVar(readString(sku.printing)) ??
			resolveFromSkuVar(readString(sku.type)) ??
			resolveFromText([
				readString(sku.var),
				readString(sku.variant),
				readString(sku.printing),
				readString(sku.type),
				readString(sku.finish),
				readString(sku.subtype),
				readString(sku.name),
				readString(sku.condition),
				readString(sku.conditionName),
				product.name,
				product.clean_name,
			])

		if (!identity) {
			continue
		}

		/**
		 * SKU data includes condition/language duplicates.
		 *
		 * Example:
		 * - Near Mint Reverse Holofoil
		 * - Lightly Played Reverse Holofoil
		 *
		 * They are the same TCGDex variant, so later dedupe by variant key.
		 */
		matches.push({
			key: variantKey(identity),
			identity,
			product,
			skuId,
			sku,
		})
	}

	return matches
}

function resolveCardTraderVariants(product: TCGTrackingProduct): ProductVariantMatch[] {
	const matches: ProductVariantMatch[] = []

	const finishes = product.cardtrader.flatMap((entry) => entry.finishes ?? [])

	for (const finish of finishes) {
		const identity = resolveFromText([
			finish,
			product.name,
			product.clean_name,
		])

		if (!identity) {
			continue
		}

		matches.push({
			key: variantKey(identity),
			identity,
			product,
		})
	}

	return matches
}

function resolveFromSkuVar(value: string | undefined): VariantIdentity | null {
	if (!value) {
		return null
	}

	const normalised = value
		.toLowerCase()
		.trim()
		.replace(/[_-]+/g, ' ')

	switch (normalised) {
		case 'n':
		case 'normal':
			return {
				type: 'normal',
			}

		case 'h':
		case 'holo':
		case 'holofoil':
		case 'holo foil':
			return {
				type: 'holo',
			}

		case 'rh':
		case 'reverse':
		case 'reverse holo':
		case 'reverse holofoil':
		case 'reverse holo foil':
			return {
				type: 'reverse',
			}

		default:
			return null
	}
}

// ---------------------------------------------------------------------------
// Variant type / foil / stamp / size detection
// ---------------------------------------------------------------------------

function resolveVariantType(text: string, foil?: string): CardVariantType {
	if (
		hasAny(text, [
			'reverse holofoil',
			'reverse holo foil',
			'reverse holo',
			'reverse foil',
			'reverse',
			'rev holo',
			'rh',
		])
	) {
		return 'reverse'
	}

	if (
		hasAny(text, [
			'holofoil',
			'holo foil',
			'holographic',
			'holo',
			'foil',
		]) ||
		foil
	) {
		return 'holo'
	}

	if (hasAny(text, ['metal', 'metal card'])) {
		return 'metal'
	}

	if (hasAny(text, ['lenticular'])) {
		return 'lenticular'
	}

	return 'normal'
}

function resolveFoil(text: string): string | undefined {
	const checks: Array<[string, string[]]> = [
		['cosmos', ['cosmos']],
		['galaxy', ['galaxy']],
		['cracked-ice', ['cracked ice', 'cracked-ice']],
		['starlight', ['starlight']],
		['energy', ['energy foil', 'energy pattern', 'energy holo', 'energy symbol']],
		['mirror', ['mirror']],
		['league', ['league foil']],
		['player-reward', ['player reward', 'player-reward']],
		['professor-program', ['professor program', 'professor-program']],
		['tinsel', ['tinsel']],
		['gold', ['gold foil']],

		// Scarlet & Violet era special reverse patterns
		['pokeball', ['poke ball', 'pokeball', 'poké ball']],
		['greatball', ['great ball', 'greatball']],
		['ultraball', ['ultra ball', 'ultraball']],
		['masterball', ['master ball', 'masterball']],

		// Extra known/suspected stamp/foil-like labels seen in data discussions
		['loveball', ['love ball', 'loveball']],
		['friendball', ['friend ball', 'friendball']],
		['quickball', ['quick ball', 'quickball']],
		['duskball', ['dusk ball', 'duskball']],
		['team-rocket', ['team rocket', 'team-rocket']],
	]

	for (const [foil, needles] of checks) {
		if (hasAny(text, needles)) {
			return foil
		}
	}

	return undefined
}

function resolveStamps(text: string): string[] {
	const stamps: string[] = []

	const checks: Array<[string, string[]]> = [
		['1st-edition', ['1st edition', 'first edition']],
		['pre-release', ['pre release', 'pre-release', 'prerelease']],
		['staff', ['staff']],
		['set-logo', ['set logo', 'set-logo']],
		['pokemon-center', ['pokemon center', 'pokémon center']],
		['gamestop', ['gamestop', 'game stop']],
		['eb-games', ['eb games', 'eb-games']],
		['snowflake', ['snowflake']],
		['trick-or-trade', ['trick or trade', 'trick-or-trade']],
		['pokemon-day', ['pokemon day', 'pokémon day']],
		['w-promo', [' w stamp', 'w promo', 'w-promo']],
		['winner', ['winner']],
		['25th-celebration', ['25th celebration', '25th anniversary']],
		['mcdonalds', ['mcdonald', "mcdonald's"]],
		['pikachu', ['pikachu stamp']],
		['bulbasaur', ['bulbasaur stamp']],
		['squirtle', ['squirtle stamp']],
		['charmander', ['charmander stamp']],
		['ace-trainer', ['ace trainer']],
	]

	for (const [stamp, needles] of checks) {
		if (hasAny(text, needles)) {
			stamps.push(stamp)
		}
	}

	return normaliseStampList(stamps)
}

function resolveSize(text: string): string | undefined {
	if (hasAny(text, ['jumbo', 'oversized', 'oversize', 'large card'])) {
		return 'jumbo'
	}

	return undefined
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function variantSortValue(match: ProductVariantMatch): number {
	switch (match.identity.type) {
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

function dedupeMatches(matches: ProductVariantMatch[]): ProductVariantMatch[] {
	const seen = new Set<string>()
	const deduped: ProductVariantMatch[] = []

	for (const match of matches.sort((a, b) => variantSortValue(a) - variantSortValue(b))) {
		/**
		 * Dedupe by product + variant identity.
		 *
		 * This removes condition/language duplicate SKUs for the same variant.
		 */
		const uniqueKey = `${match.product.id}:${match.key}`

		if (seen.has(uniqueKey)) {
			continue
		}

		seen.add(uniqueKey)
		deduped.push(match)
	}

	return deduped
}

function normaliseStampList(stamps?: string[]): string[] {
	return Array.from(
		new Set(
			(stamps ?? [])
				.map((stamp) => stamp.trim())
				.filter(Boolean),
		),
	).sort()
}

function normaliseSize(size?: string): string | undefined {
	if (!size) {
		return undefined
	}

	const normalised = size.trim().toLowerCase()

	if (!normalised || normalised === 'standard') {
		return undefined
	}

	return normalised
}

function normaliseSearchText(values: Array<string | null | undefined>): string {
	return values
		.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
		.join(' ')
		.toLowerCase()
		.replace(/[_-]+/g, ' ')
		.replace(/[()[\]{}]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
}

function hasAny(text: string, needles: string[]): boolean {
	return needles.some((needle) => text.includes(needle))
}

function readString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined
}