/**
 * CLI wrapper for src/cardmarket-catalog-linker.ts.
 *
 * Usage:
 *   bun run scripts/cardmarket-link-from-catalog.ts --set-dir <path-to-set-card-folder> [--out <file>]
 *
 * Example:
 *   bun run scripts/cardmarket-link-from-catalog.ts \
 *     --set-dir "H:/cards-database/data/Sun & Moon/Crimson Invasion" \
 *     --out cm-exports/cardmarket-CIN-catalog.json
 */

import { linkSetFromCatalog } from '../src/cardmarket-catalog-linker'

async function main() {
	const args = process.argv.slice(2)
	let setDir: string | null = null
	let outFile: string | undefined
	let catalogPath: string | undefined
	let cardsDbRoot: string | undefined

	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--set-dir') setDir = args[++i]
		else if (args[i] === '--out') outFile = args[++i]
		else if (args[i] === '--catalog') catalogPath = args[++i]
		else if (args[i] === '--cards-db') cardsDbRoot = args[++i]
	}

	if (!setDir) {
		console.error(
			'Usage: bun run scripts/cardmarket-link-from-catalog.ts --set-dir <path-to-set-card-folder> [--out <file>] [--catalog <path>] [--cards-db <path>]',
		)
		process.exit(1)
	}

	const result = await linkSetFromCatalog({ setDir, outFile, catalogPath, cardsDbRoot })

	console.log(`Set: ${result.setName} (${result.groupKey})`)
	console.log(`CardMarket expansion ID: ${result.expansionId}`)
	console.log(`\nMatched ${result.matchedCount}/${result.totalCards} cards`)

	if (result.unmatched.length > 0) {
		console.log(`Unmatched (${result.unmatched.length}):`)
		for (const u of result.unmatched.slice(0, 25)) console.log(`  ${u}`)
		if (result.unmatched.length > 25) console.log(`  ... and ${result.unmatched.length - 25} more`)
	}

	console.log(`Saved to ${result.destPath}`)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
