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

	const setFile = await importTs<{ thirdParty?: { tcgplayer?: number } }>(setFilePath)
	const tcgplayerSetId = setFile?.thirdParty?.tcgplayer

	if (typeof tcgplayerSetId !== 'number') {
		throw new Error(`Set file has no thirdParty.tcgplayer: ${setFilePath}`)
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

	const cardmarketSetCode = cardmarketContext
		? inferSetCodeFromCardmarketExport(cardmarketContext)
		: ''

	// 3. Fetch TCGTracking products and SKU variation data.
	log(`Fetching TCGTracking products for set ${tcgplayerSetId}...`)

	const [setResponse, skuResponse] = await Promise.all([
		fetchSetProducts(categoryId, tcgplayerSetId),
		fetchSetSkus(categoryId, tcgplayerSetId),
	])

	const products = attachSkusToProducts(setResponse.products, skuResponse?.products)

	log(`Found ${products.length} products`)

	if (skuResponse) {
		log(`Found ${skuResponse.sku_count ?? countSkus(skuResponse.products)} SKU variations`)
	} else {
		log('No SKU variation data found; falling back to product names/CardTrader finishes')
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