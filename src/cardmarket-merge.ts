import fs from 'node:fs/promises'
import path from 'node:path'
import type {
	CardVariantFoil,
	CardVariantType,
} from './types'

// ---------------------------------------------------------------------------
// Raw CardMarket merge export shape
// ---------------------------------------------------------------------------

export interface CardmarketMergeExport {
	meta?: {
		tool?: string
		exportedAt?: string
		groupKey?: string
		note?: string
	}
	stats?: {
		mergedKeys?: number
		baseOnly?: number
		addOnly?: number
		both?: number
	}
	byCardId: Record<string, CardmarketMergedCard>
}

export interface CardmarketMergedCard {
	cardId: string
	ids: {
		base: number[]
		additional: number[]
	}
	rawCardIds?: string[]
	cardmarketProducts: CardmarketMergedProduct[]
	sources?: CardmarketMergedProduct[]
}

export interface CardmarketMergedProduct {
	productId: number
	name: string
	variantLabel?: string
	bucket: 'base' | 'additional' | string
	rawCardId?: string
	canonicalCardId?: string
	setSlug?: string
	setName?: string
	url?: string
}

// ---------------------------------------------------------------------------
// Manual mapping shape
// ---------------------------------------------------------------------------

export interface CardmarketManualMap {
	meta: {
		tool: 'pricing-id-tooling'
		version: 1
		updatedAt: string
	}
	cards: Record<string, CardmarketManualCardMap>

	/**
	 * Per-card base product overrides.
	 *
	 * Keyed by canonical card ID (e.g. "OBF-013").
	 * Value is the CardMarket product ID that should be treated as the
	 * auto-mapped base product for that card.
	 *
	 * CardMarket does not always list the plain normal/holo/reverse product
	 * first, so this lets the user correct the designation without having to
	 * manually map every product on the card.
	 */
	baseOverrides?: Record<string, number>
}

/**
 * Keyed by CardMarket product ID as a string.
 *
 * Example:
 *
 * {
 *   "OBF-013": {
 *     "725093": { "type": "normal" },
 *     "789503": { "type": "holo", "foil": "cosmos" }
 *   }
 * }
 */
export type CardmarketManualCardMap = Record<string, CardmarketManualVariant>

export interface CardmarketManualVariant {
	type: CardVariantType
	foil?: CardVariantFoil | string
	stamp?: string[]
	size?: 'standard' | 'jumbo' | string 
	notes?: string
}

// ---------------------------------------------------------------------------
// Enriched/report-facing shape
// ---------------------------------------------------------------------------

export interface CardmarketMergeContext {
	exportPath: string
	mappingPath: string
	export: CardmarketMergeExport
	mapping: CardmarketManualMap
}

export interface CardmarketCardReview {
	cardId: string
	products: CardmarketProductReview[]
	needsMapping: boolean
	mappedCount: number
	unmappedCount: number
}

export interface CardmarketProductReview {
	productId: number
	name: string
	bucket: string
	variantLabel: string
	url?: string
	mapping?: CardmarketManualVariant
	variantKey?: string
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function loadCardmarketMergeContext(
	exportPath?: string,
	mappingPath?: string,
): Promise<CardmarketMergeContext | null> {
	if (!exportPath) {
		return null
	}

	const resolvedExportPath = path.resolve(exportPath)
	const resolvedMappingPath = mappingPath
		? path.resolve(mappingPath)
		: defaultMappingPathForExport(resolvedExportPath)

	const exportJson = await readJsonFile<CardmarketMergeExport>(resolvedExportPath)

	if (!exportJson.byCardId || typeof exportJson.byCardId !== 'object') {
		throw new Error(`Invalid CardMarket merge export: ${resolvedExportPath}`)
	}

	const mapping = await loadOrCreateManualMap(resolvedMappingPath)

	return {
		exportPath: resolvedExportPath,
		mappingPath: resolvedMappingPath,
		export: exportJson,
		mapping,
	}
}

export async function saveCardmarketManualMap(
	mappingPath: string,
	mapping: CardmarketManualMap,
): Promise<void> {
	const next: CardmarketManualMap = {
		...mapping,
		meta: {
			...mapping.meta,
			updatedAt: new Date().toISOString(),
		},
	}

	const dir = path.dirname(mappingPath)

	/**
	 * Ensure the mapping directory exists.
	 *
	 * fs.mkdir can throw EEXIST on some runtimes/platforms even when the
	 * directory already exists, so handle that safely instead of failing saves.
	 */
	try {
		await fs.mkdir(dir, { recursive: true })
	} catch (error) {
		if (!isNodeError(error) || error.code !== 'EEXIST') {
			throw error
		}
	}

	await fs.writeFile(mappingPath, `${JSON.stringify(next, null, '\t')}\n`, 'utf8')
}

export function getCardmarketReviewForCard(
	context: CardmarketMergeContext | null,
	cardId: string,
	autoBaseVariant: CardmarketManualVariant = { type: 'normal' },
): CardmarketCardReview | undefined {
	if (!context) {
		return undefined
	}

	const merged = context.export.byCardId[cardId]

	if (!merged) {
		return undefined
	}

	const manualCardMap = context.mapping.cards[cardId] ?? {}

	/**
	 * Determine which product is the base (auto-mapped) product.
	 *
	 * Default: the product whose `bucket === 'base'` in the CardMarket export.
	 *
	 * Override: if the user has assigned a different product as the base via
	 * `baseOverrides[cardId]`, that product ID takes precedence.
	 *
	 * This fixes the common case where CardMarket lists a stamped/cosmos/etc.
	 * product first, making it the "base" even though it is not the plain
	 * normal/holo variant.
	 */
	const baseOverride = context.mapping.baseOverrides?.[cardId]

	const isBaseProduct = (productId: number): boolean => {
		if (baseOverride !== undefined) {
			return productId === baseOverride
		}

		const product = merged.cardmarketProducts.find((p) => p.productId === productId)
		return product?.bucket === 'base'
	}

	const products = merged.cardmarketProducts.map((product): CardmarketProductReview => {
		const manualMapping = manualCardMap[String(product.productId)]

		/**
		 * The base product is auto-mapped from the inferred SKU variant.
		 * All other products must be manually mapped.
		 *
		 * Manual mapping always wins — the user can override the auto-mapped
		 * variant by explicitly saving a mapping for the base product.
		 */
		const autoMapping = isBaseProduct(product.productId) ? autoBaseVariant : undefined

		const mapping = manualMapping ?? autoMapping
		const variantKey = mapping ? cardmarketVariantKey(mapping) : undefined

		/**
		 * Report the effective bucket so the UI reflects any base override.
		 */
		const effectiveBucket = isBaseProduct(product.productId) ? 'base' : 'additional'

		return {
			productId: product.productId,
			name: product.name,
			bucket: effectiveBucket,
			variantLabel: product.variantLabel ?? '',
			url: product.url,
			mapping,
			variantKey,
		}
	})

	/**
	 * Only non-base products that have no mapping require action.
	 * The base product is always auto-mapped so it never blocks apply.
	 */
	const unmappedCount = products.filter(
		(product) => !product.mapping,
	).length

	const mappedCount = products.filter((product) => Boolean(product.mapping)).length

	return {
		cardId,
		products,
		needsMapping: unmappedCount > 0,
		mappedCount,
		unmappedCount,
	}
}

export function getCardmarketIdForVariant(
	context: CardmarketMergeContext | null,
	cardId: string,
	variantKey: string,
): number | undefined {
	if (!context) {
		return undefined
	}

	const manualCardMap = context.mapping.cards[cardId]

	if (!manualCardMap) {
		return undefined
	}

	for (const [productId, mapping] of Object.entries(manualCardMap)) {
		if (cardmarketVariantKey(mapping) === variantKey) {
			return Number(productId)
		}
	}

	return undefined
}

export function setCardmarketManualMapping(
	mapping: CardmarketManualMap,
	cardId: string,
	productId: number,
	variant: CardmarketManualVariant,
): CardmarketManualMap {
	const next: CardmarketManualMap = {
		...mapping,
		cards: {
			...mapping.cards,
			[cardId]: {
				...(mapping.cards[cardId] ?? {}),
				[String(productId)]: normaliseManualVariant(variant),
			},
		},
	}

	return next
}

export function removeCardmarketManualMapping(
	mapping: CardmarketManualMap,
	cardId: string,
	productId: number,
): CardmarketManualMap {
	const existingCardMap = mapping.cards[cardId]

	if (!existingCardMap) {
		return mapping
	}

	const nextCardMap = { ...existingCardMap }
	delete nextCardMap[String(productId)]

	const nextCards = { ...mapping.cards }

	if (Object.keys(nextCardMap).length === 0) {
		delete nextCards[cardId]
	} else {
		nextCards[cardId] = nextCardMap
	}

	return {
		...mapping,
		cards: nextCards,
	}
}

export function setCardmarketBaseOverride(
	mapping: CardmarketManualMap,
	cardId: string,
	productId: number,
): CardmarketManualMap {
	return {
		...mapping,
		baseOverrides: {
			...(mapping.baseOverrides ?? {}),
			[cardId]: productId,
		},
	}
}

export function clearCardmarketBaseOverride(
	mapping: CardmarketManualMap,
	cardId: string,
): CardmarketManualMap {
	const next = { ...(mapping.baseOverrides ?? {}) }
	delete next[cardId]

	return {
		...mapping,
		...(Object.keys(next).length > 0 ? { baseOverrides: next } : { baseOverrides: undefined }),
	}
}

export function cardmarketVariantKey(variant: CardmarketManualVariant): string {
	const parts = [`type:${variant.type}`]

	if (variant.foil) {
		parts.push(`foil:${variant.foil}`)
	}

	if (variant.size && variant.size !== 'standard') {
		parts.push(`size:${variant.size}`)
	}

	const stamps = normaliseStampList(variant.stamp)

	if (stamps.length > 0) {
		parts.push(`stamp:${stamps.join('+')}`)
	}

	return parts.join('|')
}

export function getCanonicalCardIdFromFilePath(
	filePath: string,
	setCode: string,
): string {
	const number = path.basename(filePath, '.ts')
	const padded = number.padStart(3, '0')

	return `${setCode.toUpperCase()}-${padded}`
}

export function inferSetCodeFromCardmarketExport(
	context: CardmarketMergeContext | null,
): string {
	const groupKey = context?.export.meta?.groupKey

	if (groupKey && groupKey.trim()) {
		return groupKey.trim().toUpperCase()
	}

	throw new Error(
		'CardMarket merge export is missing meta.groupKey. Cannot build canonical card IDs.',
	)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function loadOrCreateManualMap(mappingPath: string): Promise<CardmarketManualMap> {
	try {
		const mapping = await readJsonFile<CardmarketManualMap>(mappingPath)

		if (!mapping.cards || typeof mapping.cards !== 'object') {
			return createEmptyManualMap()
		}

		const result: CardmarketManualMap = {
			meta: {
				tool: 'pricing-id-tooling',
				version: 1,
				updatedAt: mapping.meta?.updatedAt ?? new Date().toISOString(),
			},
			cards: mapping.cards,
		}

		if (mapping.baseOverrides && typeof mapping.baseOverrides === 'object') {
			result.baseOverrides = mapping.baseOverrides
		}

		return result
	} catch (error) {
		if (isNodeError(error) && error.code === 'ENOENT') {
			return createEmptyManualMap()
		}

		throw error
	}
}

function createEmptyManualMap(): CardmarketManualMap {
	return {
		meta: {
			tool: 'pricing-id-tooling',
			version: 1,
			updatedAt: new Date().toISOString(),
		},
		cards: {},
	}
}

function defaultMappingPathForExport(exportPath: string): string {
	const parsed = path.parse(exportPath)

	return path.join(parsed.dir, `${parsed.name}.manual-map.json`)
}

async function readJsonFile<T>(filePath: string): Promise<T> {
	const raw = await fs.readFile(filePath, 'utf8')

	return JSON.parse(raw) as T
}

function normaliseManualVariant(
	variant: CardmarketManualVariant,
): CardmarketManualVariant {
	const stamp = normaliseStampList(variant.stamp)

	return {
		type: variant.type,
		...(variant.foil ? { foil: variant.foil } : {}),
		...(variant.size && variant.size !== 'standard' ? { size: variant.size } : {}),
		...(stamp.length > 0 ? { stamp } : {}),
		...(variant.notes?.trim() ? { notes: variant.notes.trim() } : {}),
	}
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error
}