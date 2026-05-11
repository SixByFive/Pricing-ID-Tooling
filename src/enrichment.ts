import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fetchSetProducts, CATEGORIES, type CategoryId } from './tcgtracking'
import { matchProductsToCards } from './matcher'
import { buildVariants, writeCardFile } from './writer'
import type { CardData, EnrichmentReport, MatchedCard } from './types'

export interface RunOptions {
	repo: string
	set: string
	apply: boolean
	log?: (line: string) => void
}

export async function runEnrichment(opts: RunOptions): Promise<EnrichmentReport> {
	const log = opts.log ?? console.log
	const repoRoot = path.resolve(opts.repo)
	const setRelPath = opts.set.replace(/\\/g, '/')
	const mode = opts.apply ? 'apply' : 'dry-run'

	log(`Mode:  ${mode}`)
	log(`Repo:  ${repoRoot}`)
	log(`Set:   ${setRelPath}`)
	log('')

	// 1. Load the set file to get the TCGPlayer set ID
	const setParts = setRelPath.split('/')
	const setFilePath = path.join(repoRoot, 'data', ...setParts.slice(0, -1), `${setParts.at(-1)}.ts`)
	const setFile = await importTs<{ thirdParty?: { tcgplayer?: number } }>(setFilePath)
	const tcgplayerSetId = setFile?.thirdParty?.tcgplayer

	if (typeof tcgplayerSetId !== 'number') {
		throw new Error(`Set file has no thirdParty.tcgplayer: ${setFilePath}`)
	}

	const categoryId: CategoryId = setRelPath.startsWith('data-asia')
		? CATEGORIES.ja
		: CATEGORIES.en

	// 2. Fetch TCGTracking products
	log(`Fetching TCGTracking products for set ${tcgplayerSetId}...`)
	const setResponse = await fetchSetProducts(categoryId, tcgplayerSetId)
	log(`Found ${setResponse.products.length} products`)

	// 3. Find card files without detailed variants
	const setDir = path.join(repoRoot, 'data', setRelPath)
	const cardFiles = await findCardFiles(setDir)
	log(`Found ${cardFiles.length} card files`)

	const eligible: Array<{ filePath: string; card: CardData }> = []

	for (const filePath of cardFiles) {
		const card = await importTs<CardData>(filePath)
		if (!card) continue
		eligible.push({ filePath, card })
	}

	log(`${eligible.length} cards eligible`)
	log('')

	// 4. Match products to cards
	const { results, orphans } = matchProductsToCards(setResponse.products, eligible)

	const matched = results.filter((r): r is MatchedCard => r.status === 'matched')
	const ambiguous = results.filter((r) => r.status === 'ambiguous')
	const unmatched = results.filter((r) => r.status === 'unmatched')
	const reviewRequired = matched.filter((r) => r.reviewRequired)

	log(`Matched:         ${matched.length}`)
	log(`Ambiguous:       ${ambiguous.length}`)
	log(`Unmatched:       ${unmatched.length}`)
	log(`Orphan products: ${orphans.length}`)
	log(`Review required: ${reviewRequired.length}`)

	// 5. Write files
	let written = 0
	let skipped = 0

	if (opts.apply) {
		log('')
		log('Writing files...')

		for (const match of matched) {
			const source = await fs.readFile(match.cardFile, 'utf8')
			const newSource = buildVariants(source, match.products)

			if (newSource === source) {
				skipped++
				continue
			}

			await writeCardFile(match.cardFile, newSource)
			written++
		}

		log(`Written: ${written}  Skipped (already complete): ${skipped}`)
	}

	const report: EnrichmentReport = {
		createdAt: new Date().toISOString(),
		repo: repoRoot,
		set: setRelPath,
		mode,
		summary: {
			cardFiles: cardFiles.length,
			matched: matched.length,
			ambiguous: ambiguous.length,
			unmatched: unmatched.length,
			orphanProducts: orphans.length,
			reviewRequired: reviewRequired.length,
			written,
			skipped,
		},
		matched,
		ambiguous,
		unmatched,
		orphanProducts: orphans,
	}

	// 6. Write report
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
			if (!serie.isDirectory()) continue
			const serieDir = path.join(dataDir, serie.name)
			const entries = await fs.readdir(serieDir, { withFileTypes: true })

			for (const entry of entries) {
				if (entry.isFile() && entry.name.endsWith('.ts')) {
					sets.push(`${serie.name}/${entry.name.replace(/\.ts$/, '')}`)
				}
			}
		}
	} catch {
		// repo path invalid or data dir missing — return empty
	}

	return sets.sort()
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
		if (entry.isDirectory()) await walk(full, out)
		else out.push(full)
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
