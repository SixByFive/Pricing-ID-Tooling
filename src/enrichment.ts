import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
	getCanonicalCardIdFromFilePath,
	getCardmarketReviewForCard,
	inferSetCodeFromCardmarketExport,
	loadCardmarketMergeContext,
	type CardmarketManualVariant,
	type CardmarketMergeContext,
} from './cardmarket-merge'
import { fetchSetProducts, fetchSetSkus, CATEGORIES, type CategoryId } from './tcgtracking'
import type { TCGTrackingSetResponse } from './types'
import { matchProductsToCards } from './matcher'
import {
	buildVariants,
	computeVariantDiff,
	ensureVariantsLast,
	fillMissingCardtraderIds,
	hasVariants,
	writeCardFile,
} from './writer'
import { resolveProductVariants } from './variant-resolver'
import type {
	AmbiguousCard,
	CardData,
	EnrichmentReport,
	MatchedCard,
	MatchResult,
	TCGTrackingProduct,
	TCGTrackingSkuEntry,
	UnmatchedCard,
} from './types'

export interface RunOptions {
	repo: string
	set: string
	apply: boolean
	log?: (line: string) => void

	/**
	 * Optional CardMarket merge export from your separate script.
	 *
	 * Example:
	 * cardmarket-OBF-merged.json
	 */
	cardmarketJson?: string

	/**
	 * Optional manual mapping path.
	 *
	 * If omitted, the tool creates/uses:
	 * <cardmarket-json-name>.manual-map.json
	 */
	cardmarketMap?: string

	/**
	 * Safe fill mode: only add missing cardtrader IDs to existing detailed variants.
	 *
	 * When true:
	 * - Never converts simple variants to detailed array shape
	 * - Never creates new variants
	 * - Never removes top-level thirdParty
	 * - Never overwrites existing cardmarket, tcgplayer, or cardtrader
	 */
	fillMissingCardtrader?: boolean

	/**
	 * Manual override for the TCGPlayer set ID.
	 *
	 * Used when the set file in the repo doesn't yet have a thirdParty.tcgplayer value.
	 */
	tcgplayerSetId?: number

	/**
	 * Path to a local TCGTracking set JSON file.
	 *
	 * When provided, products are loaded from the file instead of fetched from the API.
	 * The set_id is extracted from the file and used as the TCGPlayer set ID.
	 */
	tcgplayerJson?: string
}

export async function runEnrichment(opts: RunOptions): Promise<EnrichmentReport> {
	const log = opts.log ?? console.log
	const repoRoot = path.resolve(opts.repo)
	const setRelPath = opts.set.replace(/\\/g, '/')
	const mode = opts.apply ? 'apply' : 'dry-run'
	const fillMode = opts.fillMissingCardtrader ?? false

	log(`Mode:  ${mode}${fillMode ? ' (fill-missing-cardtrader)' : ''}`)
	log(`Repo:  ${repoRoot}`)
	log(`Set:   ${setRelPath}`)

	if (opts.cardmarketJson) {
		log(`CardMarket merge: ${path.resolve(opts.cardmarketJson)}`)
	}

	if (opts.cardmarketMap) {
		log(`CardMarket map:   ${path.resolve(opts.cardmarketMap)}`)
	}

	log('')

	// 1. Load the set file to get the TCGPlayer set ID.
	const setParts = setRelPath.split('/')
	const setFilePath = path.join(
		repoRoot,
		'data',
		...setParts.slice(0, -1),
		`${setParts.at(-1)}.ts`,
	)

	// Load the local TCGTracking JSON/CSV if provided — it supplies both set_id and products.
	let localSetResponse: TCGTrackingSetResponse | undefined
	if (opts.tcgplayerJson) {
		const raw = await fs.readFile(opts.tcgplayerJson, 'utf8')

		if (opts.tcgplayerJson.toLowerCase().endsWith('.csv')) {
			// TCGCSV format: CSV export from tcgcsv.com
			localSetResponse = parseTcgcsv(raw)
		} else {
			const parsed = JSON.parse(raw)
			if (parsed && Array.isArray(parsed.products)) {
				// Raw TCGTracking API shape: { set_id, products: [...] }
				localSetResponse = parsed as TCGTrackingSetResponse
			} else if (parsed && parsed.byCardId && typeof parsed.byCardId === 'object') {
				// Custom sbf-tcgplayer-set-exporter shape: { meta: { groupId }, byCardId: { ... } }
				localSetResponse = parseTcgplayerExport(parsed)
			} else if (parsed && parsed.meta?.tool === 'pricing-id-tooling') {
				throw new Error(
					`The file in the 'TCGPlayer JSON' field is a CardMarket map file, not a TCGPlayer export. Please clear the TCGPlayer JSON field in the UI: ${opts.tcgplayerJson}`,
				)
			} else {
				throw new Error(
					`TCGPlayer JSON is not a recognised format. Expected either a TCGTracking API response ({ set_id, products: [...] }) or a sbf-tcgplayer-set-exporter file ({ meta, byCardId: {...} }): ${opts.tcgplayerJson}`,
				)
			}
		}

		log(`TCGPlayer data: ${path.resolve(opts.tcgplayerJson)} (${localSetResponse.products.length} products)`)
	}

	const setFile = await importTs<{ thirdParty?: { tcgplayer?: number } }>(setFilePath)
	const tcgplayerSetId =
		opts.tcgplayerSetId ?? localSetResponse?.set_id ?? setFile?.thirdParty?.tcgplayer

	if (opts.tcgplayerSetId && setFile?.thirdParty?.tcgplayer !== opts.tcgplayerSetId) {
		log(`TCGPlayer set ID: ${opts.tcgplayerSetId} (manual override)`)
	}

	const categoryId: CategoryId = setRelPath.startsWith('data-asia')
		? CATEGORIES.ja
		: CATEGORIES.en

	// 2. Load optional CardMarket merge context.
	const cardmarketContext = await loadCardmarketMergeContext(
		opts.cardmarketJson,
		opts.cardmarketMap,
	)

	if (cardmarketContext) {
		log(
			`Loaded CardMarket merge: ${
				cardmarketContext.export.stats?.mergedKeys ??
				Object.keys(cardmarketContext.export.byCardId).length
			} cards`,
		)
		log(`Manual map: ${cardmarketContext.mappingPath}`)
		log('')
	}

	// When no TCGPlayer set ID is available, fall back to CardMarket-only mode if we have
	// CM context. Without a set ID we cannot fetch products, so only CM IDs are written.
	const cardmarketOnlyMode = typeof tcgplayerSetId !== 'number'

	if (cardmarketOnlyMode) {
		if (!cardmarketContext) {
			throw new Error(
				`Set file has no thirdParty.tcgplayer and no CardMarket context is available. ` +
				`Provide a TCGPlayer set ID, a TCGPlayer JSON file, or a CardMarket export: ${setFilePath}`,
			)
		}
		log('No TCGPlayer set ID — running in CardMarket-only mode (CardMarket IDs will be written, TCGPlayer IDs skipped)')
		log('')
	}

	const cardmarketSetCode = cardmarketContext
		? inferSetCodeFromCardmarketExport(cardmarketContext)
		: ''

	// 3. Load TCGTracking products and SKU variation data.
	let products: TCGTrackingProduct[]

	// When a file AND a set ID pointing to a different group are both supplied,
	// the file covers a sub-set (e.g. Galarian Gallery CSV, group 17689) and the
	// set ID covers the main set (e.g. Crown Zenith, group 17688). Fetch the main
	// set from the API and merge the file products in, deduplicating by product ID.
	const hasExtraSetId =
		typeof tcgplayerSetId === 'number' &&
		localSetResponse &&
		localSetResponse.set_id !== tcgplayerSetId

	if (cardmarketOnlyMode) {
		products = []
	} else if (localSetResponse && hasExtraSetId) {
		// Merge: API products for the main set + file products for the sub-set.
		log(`Fetching TCGTracking products for set ${tcgplayerSetId} (main set)...`)
		const [setResponse, skuResponse] = await Promise.all([
			fetchSetProducts(categoryId, tcgplayerSetId!),
			fetchSetSkus(categoryId, tcgplayerSetId!),
		])
		const apiProducts = attachSkusToProducts(setResponse.products, skuResponse?.products)
		log(`Found ${apiProducts.length} products from API`)
		if (skuResponse) {
			log(`Found ${skuResponse.sku_count ?? countSkus(skuResponse.products)} SKU variations`)
		}

		// File products (sub-set) already have embedded SKUs — merge, API first so
		// file products win on any ID collision.
		const apiProductIds = new Set(apiProducts.map((p) => p.id))
		const extraProducts = localSetResponse.products.filter((p) => !apiProductIds.has(p.id))
		log(`Merging ${extraProducts.length} sub-set products from file (${localSetResponse.products.length} total, ${localSetResponse.products.length - extraProducts.length} already in API set)`)
		products = [...apiProducts, ...extraProducts]
		log(`Total products after merge: ${products.length}`)
	} else if (localSetResponse) {
		// Products came from the local file only — check whether SKUs are already embedded.
		const hasSkus = localSetResponse.products.some((p: TCGTrackingProduct) => p.skus && Object.keys(p.skus).length > 0)

		if (hasSkus) {
			log(`Loaded ${localSetResponse.products.length} products with embedded SKUs from file`)
			products = localSetResponse.products
		} else {
			log(`Loaded ${localSetResponse.products.length} products from file — fetching SKUs from API...`)
			const skuResponse = await fetchSetSkus(categoryId, tcgplayerSetId!)
			products = attachSkusToProducts(localSetResponse.products, skuResponse?.products)
			if (skuResponse) {
				log(`Found ${skuResponse.sku_count ?? countSkus(skuResponse.products)} SKU variations`)
			} else {
				log('No SKU variation data found; falling back to product names/CardTrader finishes')
			}
		}
	} else {
		log(`Fetching TCGTracking products for set ${tcgplayerSetId}...`)
		const [setResponse, skuResponse] = await Promise.all([
			fetchSetProducts(categoryId, tcgplayerSetId!),
			fetchSetSkus(categoryId, tcgplayerSetId!),
		])
		products = attachSkusToProducts(setResponse.products, skuResponse?.products)
		log(`Found ${products.length} products`)
		if (skuResponse) {
			log(`Found ${skuResponse.sku_count ?? countSkus(skuResponse.products)} SKU variations`)
		} else {
			log('No SKU variation data found; falling back to product names/CardTrader finishes')
		}
	}

	// 4. Find card files.
	const setDir = path.join(repoRoot, 'data', setRelPath)
	const cardFiles = await findCardFiles(setDir)

	log(`Found ${cardFiles.length} card files`)

	const eligible: Array<{ filePath: string; card: CardData }> = []

	for (const filePath of cardFiles) {
		const card = await importTs<CardData>(filePath)

		if (!card) {
			continue
		}

		eligible.push({
			filePath,
			card,
		})
	}

	log(`${eligible.length} cards eligible`)
	log('')

	// 5. Match products to cards.
	const { results, orphans } = matchProductsToCards(products, eligible)

	const resultsWithCardmarket = attachCardmarketReviewToResults(
		results,
		cardmarketContext,
		cardmarketSetCode,
	)

	const resultsWithReviewFlags = markCardmarketReviewRequired(resultsWithCardmarket)

	const matched = resultsWithReviewFlags.filter((r): r is MatchedCard => {
		return r.status === 'matched'
	})

	const ambiguous = resultsWithReviewFlags.filter((r): r is AmbiguousCard => {
		return r.status === 'ambiguous'
	})

	const unmatched = resultsWithReviewFlags.filter((r): r is UnmatchedCard => {
		return r.status === 'unmatched'
	})

	const reviewRequired = matched.filter((r) => r.reviewRequired)
	const cardmarketSummary = summariseCardmarketReviews(resultsWithReviewFlags)

	log(`Matched:         ${matched.length}`)
	log(`Ambiguous:       ${ambiguous.length}`)
	log(`Unmatched:       ${unmatched.length}`)
	log(`Orphan products: ${orphans.length}`)
	log(`Review required: ${reviewRequired.length}`)

	if (cardmarketContext) {
		log('')
		log(`CardMarket cards with review:   ${cardmarketSummary.cardmarketCardsWithReview}`)
		log(`CardMarket mapped products:     ${cardmarketSummary.cardmarketMappedProducts}`)
		log(`CardMarket unmapped products:   ${cardmarketSummary.cardmarketUnmappedProducts}`)
		log(`CardMarket cards needing map:   ${cardmarketSummary.cardmarketCardsNeedingMapping}`)
	}

	// 6. Apply guard.
	if (
		opts.apply &&
		!fillMode &&
		cardmarketContext &&
		cardmarketSummary.cardmarketUnmappedProducts > 0
	) {
		throw new Error(
			`Apply blocked: ${cardmarketSummary.cardmarketUnmappedProducts} CardMarket product mappings are still unmapped across ${cardmarketSummary.cardmarketCardsNeedingMapping} cards. Complete the CardMarket mapping before applying.`,
		)
	}

	// 7. Compute per-card variant diffs (both modes) and write files (apply only).
	let written = 0
	let skipped = 0
	let noVariantsCount = 0

	const matchedWithDiffs: MatchedCard[] = []
	const fileErrors: Array<{ file: string; reason: string }> = []

	if (opts.apply) {
		log('')
		log('Writing files...')
	}

	for (const match of matched) {
		try {
			const source = await fs.readFile(match.cardFile, 'utf8')

			if (!hasVariants(source)) {
				noVariantsCount++
				matchedWithDiffs.push(match)
				continue
			}

			const variantChanges = fillMode
				? undefined
				: computeVariantDiff(source, match.products, {
						cardmarketReview: match.cardmarketReview,
					})

			matchedWithDiffs.push({ ...match, variantChanges })

			if (!opts.apply) {
				continue
			}

			const builtSource = fillMode
				? fillMissingCardtraderIds(source, match.products)
				: buildVariants(source, match.products, {
						cardmarketReview: match.cardmarketReview,
					})

			const normalisedNewSource = ensureNewlineAtEof(
				ensureVariantsLast(builtSource),
			)

			if (normalisedNewSource === ensureNewlineAtEof(source)) {
				skipped++
				continue
			}

			await writeCardFile(match.cardFile, normalisedNewSource)
			written++
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error)
			const shortPath = path.relative(repoRoot, match.cardFile)

			if (opts.apply) {
				log(`  ERROR: ${shortPath}`)
				log(`         ${reason.split('\n')[0]}`)
			}

			fileErrors.push({ file: match.cardFile, reason })
			matchedWithDiffs.push(match)
		}
	}

	// In CardMarket-only mode (no TCGPlayer products), also process unmatched cards
	// that have CM data — these are cards the matcher couldn't pair with any TCGPlayer
	// product, but whose CM IDs can still be written from the manual map.
	const unmatchedWithCm = unmatched.filter((u) => u.cardmarketReview)

	for (const match of unmatchedWithCm) {
		try {
			const source = await fs.readFile(match.cardFile, 'utf8')

			if (!hasVariants(source)) {
				noVariantsCount++
				continue
			}

			if (!opts.apply) {
				continue
			}

			const builtSource = buildVariants(source, [], {
				cardmarketReview: match.cardmarketReview,
			})

			const normalisedNewSource = ensureNewlineAtEof(ensureVariantsLast(builtSource))

			if (normalisedNewSource === ensureNewlineAtEof(source)) {
				skipped++
				continue
			}

			await writeCardFile(match.cardFile, normalisedNewSource)
			written++
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error)
			const shortPath = path.relative(repoRoot, match.cardFile)

			if (opts.apply) {
				log(`  ERROR: ${shortPath}`)
				log(`         ${reason.split('\n')[0]}`)
			}

			fileErrors.push({ file: match.cardFile, reason })
		}
	}

	if (opts.apply) {
		const parts = [`Written: ${written}  Skipped (already complete): ${skipped}`]

		if (noVariantsCount > 0) parts.push(`No variants: ${noVariantsCount}`)
		if (fileErrors.length > 0) parts.push(`Errors: ${fileErrors.length}`)

		log(parts.join('  '))

		if (fileErrors.length > 0) {
			const summary = fileErrors
				.map(({ file, reason }) => `  ${file}\n  ${reason}`)
				.join('\n\n')

			throw new Error(`${fileErrors.length} file(s) failed during write:\n\n${summary}`)
		}
	}

	const report: EnrichmentReport = {
		createdAt: new Date().toISOString(),
		repo: repoRoot,
		set: setRelPath,
		mode,

		...(cardmarketContext
			? {
					cardmarket: {
						exportPath: cardmarketContext.exportPath,
						mappingPath: cardmarketContext.mappingPath,
						mergedKeys:
							cardmarketContext.export.stats?.mergedKeys ??
							Object.keys(cardmarketContext.export.byCardId).length,
						baseOnly: cardmarketContext.export.stats?.baseOnly ?? 0,
						addOnly: cardmarketContext.export.stats?.addOnly ?? 0,
						both: cardmarketContext.export.stats?.both ?? 0,
					},
				}
			: {}),

		summary: {
			cardFiles: cardFiles.length,
			matched: matched.length,
			ambiguous: ambiguous.length,
			unmatched: unmatched.length,
			orphanProducts: orphans.length,
			reviewRequired: reviewRequired.length,
			written,
			skipped,
			noVariants: noVariantsCount,
			cardmarketCardsWithReview: cardmarketSummary.cardmarketCardsWithReview,
			cardmarketMappedProducts: cardmarketSummary.cardmarketMappedProducts,
			cardmarketUnmappedProducts: cardmarketSummary.cardmarketUnmappedProducts,
			cardmarketCardsNeedingMapping: cardmarketSummary.cardmarketCardsNeedingMapping,
		},

		matched: matchedWithDiffs,
		ambiguous,
		unmatched,
		orphanProducts: orphans,
	}

	// 7. Write report.
	const reportDir = path.join(process.cwd(), 'var', 'reports')
	await fs.mkdir(reportDir, { recursive: true })

	const setSlug = setRelPath.replace(/[/\\]/g, '-')
	const reportFile = path.join(reportDir, `enrichment-${setSlug}.json`)

	await fs.writeFile(reportFile, `${JSON.stringify(report, null, '\t')}\n`, 'utf8')

	log(`Report: var/reports/enrichment-${setSlug}.json`)

	return report
}

export async function listSets(repoRoot: string): Promise<string[]> {
	const dataDir = path.join(repoRoot, 'data')
	const sets: string[] = []

	try {
		const series = await fs.readdir(dataDir, { withFileTypes: true })

		for (const serie of series) {
			if (!serie.isDirectory()) {
				continue
			}

			const serieDir = path.join(dataDir, serie.name)
			const entries = await fs.readdir(serieDir, { withFileTypes: true })

			for (const entry of entries) {
				if (entry.isFile() && entry.name.endsWith('.ts')) {
					sets.push(`${serie.name}/${entry.name.replace(/\.ts$/, '')}`)
				}
			}
		}
	} catch {
		// Repo path invalid or data dir missing — return empty.
	}

	return sets.sort()
}

// ---------------------------------------------------------------------------
// CardMarket review helpers
// ---------------------------------------------------------------------------

function attachCardmarketReviewToResults(
	results: MatchResult[],
	context: CardmarketMergeContext | null,
	setCode: string,
): MatchResult[] {
	if (!context) {
		return results
	}

	return results.map((result): MatchResult => {
		const cardId = getCanonicalCardIdFromFilePath(result.cardFile, setCode)

		const autoBaseVariant =
			result.status === 'matched' || result.status === 'ambiguous'
				? inferCardmarketBaseVariant(result.products)
				: { type: 'normal' as const }

		const cardmarketReview = getCardmarketReviewForCard(
			context,
			cardId,
			autoBaseVariant,
		)

		if (!cardmarketReview) {
			return result
		}

		switch (result.status) {
			case 'matched':
				return {
					...result,
					cardmarketReview,
				}

			case 'ambiguous':
				return {
					...result,
					cardmarketReview,
				}

			case 'unmatched':
				return {
					...result,
					cardmarketReview,
				}
		}
	})
}

function inferCardmarketBaseVariant(
	products: TCGTrackingProduct[],
): CardmarketManualVariant {
	// Use the full variant resolver so all SKU var text formats are handled
	// (e.g. 'HoloFoil', not just the short code 'H').
	const types = new Set<string>()

	for (const product of products) {
		for (const { identity } of resolveProductVariants(product)) {
			// Only plain (non-foil, non-stamp, standard-size) variants determine the base type.
			if (!identity.foil && !identity.size && !(identity.stamp?.length)) {
				types.add(identity.type)
			}
		}
	}

	// Priority: normal > holo > reverse.
	// When both normal and reverse exist, normal is the base (they share one CardMarket listing).
	if (types.has('normal')) return { type: 'normal' }
	if (types.has('holo')) return { type: 'holo' }
	if (types.has('reverse')) return { type: 'reverse' }

	return { type: 'normal' }
}

function summariseCardmarketReviews(results: MatchResult[]): {
	cardmarketCardsWithReview: number
	cardmarketMappedProducts: number
	cardmarketUnmappedProducts: number
	cardmarketCardsNeedingMapping: number
} {
	let cardmarketCardsWithReview = 0
	let cardmarketMappedProducts = 0
	let cardmarketUnmappedProducts = 0
	let cardmarketCardsNeedingMapping = 0

	for (const result of results) {
		const review = result.cardmarketReview

		if (!review) {
			continue
		}

		cardmarketCardsWithReview++
		cardmarketMappedProducts += review.mappedCount
		cardmarketUnmappedProducts += review.unmappedCount

		if (review.needsMapping) {
			cardmarketCardsNeedingMapping++
		}
	}

	return {
		cardmarketCardsWithReview,
		cardmarketMappedProducts,
		cardmarketUnmappedProducts,
		cardmarketCardsNeedingMapping,
	}
}

function markCardmarketReviewRequired(results: MatchResult[]): MatchResult[] {
	return results.map((result): MatchResult => {
		if (
			result.status === 'matched' &&
			result.cardmarketReview?.needsMapping
		) {
			return {
				...result,
				reviewRequired: true,
			}
		}

		return result
	})
}

// ---------------------------------------------------------------------------
// TCGTracking SKU helpers
// ---------------------------------------------------------------------------

function attachSkusToProducts(
	products: TCGTrackingProduct[],
	skusByProductId?: Record<string, Record<string, TCGTrackingSkuEntry>>,
): TCGTrackingProduct[] {
	if (!skusByProductId) {
		return products
	}

	return products.map((product): TCGTrackingProduct => {
		const skus = skusByProductId[String(product.id)]

		if (!skus) {
			return product
		}

		return {
			...product,
			skus,
		}
	})
}

function countSkus(
	skusByProductId: Record<string, Record<string, TCGTrackingSkuEntry>>,
): number {
	return Object.values(skusByProductId).reduce((total, productSkus) => {
		return total + Object.keys(productSkus).length
	}, 0)
}

function readString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim()
		? value.trim()
		: undefined
}

// ---------------------------------------------------------------------------
// TCGCSV format parser (tcgcsv.com CSV export)
// ---------------------------------------------------------------------------

function parseTcgcsv(csv: string): TCGTrackingSetResponse {
	const rows = parseCsvRows(csv)

	if (rows.length < 2) {
		return { set_id: 0, set_name: '', set_abbr: '', products: [] }
	}

	const headers = rows[0]
	const idx = (name: string) => headers.indexOf(name)

	const colProductId = idx('productId')
	const colName = idx('name')
	const colCleanName = idx('cleanName')
	const colGroupId = idx('groupId')
	const colExtNumber = idx('extNumber')
	const colExtRarity = idx('extRarity')
	const colSubTypeName = idx('subTypeName')

	if (colProductId < 0 || colExtNumber < 0) {
		throw new Error(
			'TCGCSV file is missing required columns (productId, extNumber). ' +
			'Download the file from tcgcsv.com and try again.',
		)
	}

	const products: TCGTrackingProduct[] = []
	let set_id = 0

	for (let i = 1; i < rows.length; i++) {
		const row = rows[i]

		const productId = parseInt(row[colProductId] ?? '', 10)
		if (!productId || isNaN(productId)) continue

		if (!set_id && colGroupId >= 0) {
			const gid = parseInt(row[colGroupId] ?? '', 10)
			if (gid && !isNaN(gid)) set_id = gid
		}

		// extNumber like "GG19/GG70" or "TG01/TG30" — strip the "/TOTAL" part
		const extNumber = (row[colExtNumber] ?? '').trim()
		const number = extNumber.split('/')[0].trim() || null

		const subTypeName = colSubTypeName >= 0 ? (row[colSubTypeName] ?? '').trim() : ''
		const skus: Record<string, TCGTrackingSkuEntry> = {}
		if (subTypeName) {
			skus['0'] = { var: subTypeName }
		}

		products.push({
			id: productId,
			name: colName >= 0 ? (row[colName] ?? '').trim() : String(productId),
			clean_name: colCleanName >= 0
				? (row[colCleanName] ?? '').trim() || (row[colName] ?? '').trim()
				: colName >= 0 ? (row[colName] ?? '').trim() : String(productId),
			number,
			rarity: colExtRarity >= 0 ? ((row[colExtRarity] ?? '').trim() || null) : null,
			cardmarket_id: null,
			cardtrader_id: null,
			cardtrader: [],
			skus: Object.keys(skus).length > 0 ? skus : undefined,
		})
	}

	return { set_id, set_name: '', set_abbr: '', products }
}

function parseCsvRows(csv: string): string[][] {
	const rows: string[][] = []
	let current: string[] = []
	let field = ''
	let inQuotes = false

	for (let i = 0; i < csv.length; i++) {
		const ch = csv[i]

		if (inQuotes) {
			if (ch === '"') {
				if (csv[i + 1] === '"') {
					// Escaped quote: "" → "
					field += '"'
					i++
				} else {
					inQuotes = false
				}
			} else {
				field += ch
			}
		} else if (ch === '"') {
			inQuotes = true
		} else if (ch === ',') {
			current.push(field)
			field = ''
		} else if (ch === '\r') {
			// Skip CR in CRLF sequences
		} else if (ch === '\n') {
			current.push(field)
			field = ''
			if (current.length > 0) rows.push(current)
			current = []
		} else {
			field += ch
		}
	}

	// Push the final row (file may not end with newline)
	if (field || current.length > 0) {
		current.push(field)
		if (current.some((f) => f.trim())) rows.push(current)
	}

	return rows
}

// ---------------------------------------------------------------------------
// sbf-tcgplayer-set-exporter format parser
// ---------------------------------------------------------------------------

function parseTcgplayerExport(data: {
	meta?: { groupId?: number; groupKey?: string; groupName?: string }
	byCardId?: Record<
		string,
		{
			cardId?: string
			tcgplayerProducts?: Array<{
				productId: number
				name: string
				rarity?: string | null
				printings?: string[]
			}>
		}
	>
}): TCGTrackingSetResponse {
	const products: TCGTrackingProduct[] = []

	for (const [cardId, entry] of Object.entries(data.byCardId ?? {})) {
		// Collector number = everything after the set code prefix (e.g. "MEP-001" → "001")
		const number = cardId.split('-').slice(1).join('-') || null

		for (const p of entry.tcgplayerProducts ?? []) {
			// Synthesise one SKU per printing so resolveSkuVariants can detect variant type
			const skus: Record<string, TCGTrackingSkuEntry> = {}
			for (let i = 0; i < (p.printings?.length ?? 0); i++) {
				skus[String(i)] = { var: p.printings![i] }
			}

			products.push({
				id: p.productId,
				name: p.name,
				clean_name: p.name,
				number,
				rarity: p.rarity ?? null,
				cardmarket_id: null,
				cardtrader_id: null,
				cardtrader: [],
				skus: Object.keys(skus).length > 0 ? skus : undefined,
			})
		}
	}

	return {
		set_id: data.meta?.groupId ?? 0,
		set_name: data.meta?.groupName ?? '',
		set_abbr: data.meta?.groupKey ?? '',
		products,
	}
}

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

async function findCardFiles(dir: string): Promise<string[]> {
	const files: string[] = []

	try {
		await walk(dir, files)
	} catch (error) {
		if (isNodeError(error) && error.code === 'ENOENT') {
			throw new Error(`Set directory not found: ${dir}`)
		}

		throw error
	}

	return files.filter((f) => f.endsWith('.ts'))
}

async function walk(dir: string, out: string[]): Promise<void> {
	const entries = await fs.readdir(dir, { withFileTypes: true })

	for (const entry of entries) {
		const full = path.join(dir, entry.name)

		if (entry.isDirectory()) {
			await walk(full, out)
		} else {
			out.push(full)
		}
	}
}

async function importTs<T>(filePath: string): Promise<T | null> {
	try {
		const mod = await import(pathToFileURL(path.resolve(filePath)).href)
		return (mod.default ?? null) as T | null
	} catch {
		return null
	}
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error
}

function ensureNewlineAtEof(source: string): string {
	return source.endsWith('\n') ? source : `${source}\n`
}