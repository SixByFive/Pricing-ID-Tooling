/**
 * Builds a CardMarket merge JSON (same shape as cardmarket-exporter.user.js /
 * cardmarket-scrape.ts) from CardMarket's official, publicly-downloadable
 * product catalog — no scraping, no Cloudflare risk at all.
 *
 * READ-ONLY against the cards-database repo (just reads card/set files and
 * the cm_expansions.ts map for reference) — never edits anything there.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

interface CatalogProduct {
	idProduct: number
	name: string
	idCategory: number
	categoryName: string
	idExpansion: number
	idMetacard: number
	dateAdded: string
}

interface CatalogFile {
	version: number
	createdAt: string
	products: CatalogProduct[]
}

interface MergedProduct {
	productId: number
	name: string
	variantLabel: string
	bucket: 'base'
}

interface MergedCard {
	cardId: string
	ids: { base: number[]; additional: number[] }
	rawCardIds: string[]
	cardmarketProducts: MergedProduct[]
}

export interface SetInfo {
	name: string
	code: string
	cardmarketExpansion?: number
}

export interface LinkSetOptions {
	setDir: string
	outFile?: string
	outDir?: string
	catalogPath?: string
	cardsDbRoot?: string
}

export interface LinkSetResult {
	setName: string
	groupKey: string
	expansionId: number
	totalCards: number
	matchedCount: number
	unmatched: string[]
	destPath: string
}

async function loadExpansionMap(cardsDbRoot: string): Promise<Map<string, number>> {
	const filePath = path.join(cardsDbRoot, 'scripts/utils-data/cm_expansions.ts')
	const text = await fs.readFile(filePath, 'utf8')
	const map = new Map<string, number>()

	const re = /\[\s*(['"])((?:\\.|(?!\1).)*)\1\s*,\s*(\d+)\s*\]/g
	let m: RegExpExecArray | null
	while ((m = re.exec(text))) {
		const name = m[2].replace(/\\(['"])/g, '$1')
		map.set(name, Number(m[3]))
	}
	return map
}

async function extractCardName(filePath: string): Promise<string | null> {
	const src = await fs.readFile(filePath, 'utf8')
	const m = src.match(/name:\s*\{\s*en:\s*"((?:\\.|[^"\\])*)"/)
	if (!m) return null
	return m[1].replace(/\\(.)/g, '$1')
}

async function extractSetInfo(setFilePath: string): Promise<SetInfo | null> {
	const src = await fs.readFile(setFilePath, 'utf8')
	const nameMatch = src.match(/name:\s*\{\s*en:\s*"((?:\\.|[^"\\])*)"/)
	const codeMatch =
		src.match(/tcgOnline:\s*['"]([^'"]+)['"]/) ??
		src.match(/abbreviations:\s*\{\s*official:\s*['"]([^'"]+)['"]/)
	const cmMatch = src.match(/thirdParty:\s*\{[^}]*cardmarket:\s*(\d+)/s)

	if (!nameMatch || !codeMatch) return null

	return {
		name: nameMatch[1].replace(/\\(.)/g, '$1'),
		code: codeMatch[1],
		cardmarketExpansion: cmMatch ? Number(cmMatch[1]) : undefined,
	}
}

export async function linkSetFromCatalog(options: LinkSetOptions): Promise<LinkSetResult> {
	const cardsDbRoot = options.cardsDbRoot ?? 'H:/cards-database'
	const catalogPath = options.catalogPath ?? path.resolve('var/cardmarket/products_singles.json')

	const setDirAbs = path.resolve(options.setDir)
	const setFilePath = `${setDirAbs}.ts`

	const setInfo = await extractSetInfo(setFilePath)
	if (!setInfo) {
		throw new Error(`Could not extract set name/code from ${setFilePath}`)
	}

	let expansionId = setInfo.cardmarketExpansion

	if (!expansionId) {
		const expansionMap = await loadExpansionMap(cardsDbRoot)
		expansionId = expansionMap.get(setInfo.name)
	}

	if (!expansionId) {
		throw new Error(
			`No CardMarket expansion ID found for "${setInfo.name}" (checked the set file's thirdParty.cardmarket and cm_expansions.ts).`,
		)
	}

	const catalogRaw = await fs.readFile(catalogPath, 'utf8')
	const catalog: CatalogFile = JSON.parse(catalogRaw)

	const productsInExpansion = catalog.products.filter((p) => p.idExpansion === expansionId)

	const cardFiles = (await fs.readdir(setDirAbs)).filter((f) => f.endsWith('.ts'))

	const byCardId: Record<string, MergedCard> = {}
	const unmatched: string[] = []
	const usedProductIds = new Set<number>()

	for (const file of cardFiles) {
		const filePath = path.join(setDirAbs, file)
		const name = await extractCardName(filePath)
		if (!name) continue

		const matches = productsInExpansion.filter(
			(p) => p.name.startsWith(name) && !usedProductIds.has(p.idProduct),
		)

		if (matches.length === 0) {
			unmatched.push(`${file}: "${name}"`)
			continue
		}

		for (const m of matches) usedProductIds.add(m.idProduct)

		const number = path.basename(file, '.ts')
		const cardId = `${setInfo.code.toUpperCase()}-${number.padStart(3, '0')}`

		byCardId[cardId] = {
			cardId,
			ids: { base: matches.map((m) => m.idProduct), additional: [] },
			rawCardIds: [cardId],
			cardmarketProducts: matches.map((m) => ({
				productId: m.idProduct,
				name: m.name,
				variantLabel: '',
				bucket: 'base' as const,
			})),
		}
	}

	const matchedCount = Object.keys(byCardId).length
	const groupKey = setInfo.code.toUpperCase()

	const payload = {
		meta: {
			tool: 'cardmarket-link-from-catalog.ts (official product catalog, no scraping)',
			exportedAt: new Date().toISOString(),
			groupKey,
			note: `Built from CardMarket's official public product catalog (idExpansion=${expansionId}), matched by card name startsWith(). Not scraped — no Cloudflare risk.`,
		},
		stats: { mergedKeys: matchedCount, baseOnly: matchedCount, addOnly: 0, both: 0 },
		byCardId,
	}

	const outDir = options.outDir ?? path.join(process.cwd(), 'cm-exports')
	const dest = options.outFile ?? path.join(outDir, `cardmarket-${groupKey}-catalog.json`)
	await fs.mkdir(path.dirname(dest), { recursive: true })
	await fs.writeFile(dest, JSON.stringify(payload, null, 2), 'utf8')

	return {
		setName: setInfo.name,
		groupKey,
		expansionId,
		totalCards: cardFiles.length,
		matchedCount,
		unmatched,
		destPath: dest,
	}
}
