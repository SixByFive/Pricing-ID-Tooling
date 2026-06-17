import { runEnrichment } from './enrichment'

interface CliOptions {
	repo: string
	set?: string
	apply: boolean
	help: boolean
	fillMissingCardtrader: boolean

	/**
	 * Optional CardMarket merge export from your separate script.
	 *
	 * Example:
	 * --cardmarket-json ./cardmarket-OBF-merged.json
	 */
	cardmarketJson?: string

	/**
	 * Optional manual CardMarket variant mapping file.
	 *
	 * Example:
	 * --cardmarket-map ./cardmarket-OBF-merged.manual-map.json
	 *
	 * If omitted, the tooling will default to:
	 * <cardmarket-json-name>.manual-map.json
	 */
	cardmarketMap?: string

	/**
	 * Override the TCGPlayer set ID.
	 *
	 * Used when the set file does not yet have a thirdParty.tcgplayer value.
	 */
	tcgplayerSetId?: number

	/**
	 * Path to a local TCGPlayer set JSON file.
	 *
	 * Supported formats:
	 * - TCGTracking API response: { set_id, products: [...] }
	 * - sbf-tcgplayer-set-exporter: { meta: { groupId, groupKey }, byCardId: {...} }
	 */
	tcgplayerJson?: string
}

const options = parseArgs(process.argv.slice(2))

if (options.help) {
	printHelp()
	process.exit(0)
}

if (!options.set) {
	console.error('Missing required argument: --set')
	console.error('')
	printHelp()
	process.exit(1)
}

console.log('')
console.log('Pricing-ID Tooling')
console.log('------------------')

const modeLabel = options.fillMissingCardtrader
	? `${options.apply ? 'apply' : 'dry-run'} (fill-missing-cardtrader)`
	: options.apply ? 'apply' : 'dry-run'

console.log(`Mode: ${modeLabel}`)
console.log(`Repo: ${options.repo}`)
console.log(`Set:  ${options.set}`)

if (options.cardmarketJson) {
	console.log(`CardMarket merge JSON: ${options.cardmarketJson}`)
}

if (options.cardmarketMap) {
	console.log(`CardMarket manual map: ${options.cardmarketMap}`)
}

console.log('')

await runEnrichment({
	repo: options.repo,
	set: options.set,
	apply: options.apply,
	cardmarketJson: options.cardmarketJson,
	cardmarketMap: options.cardmarketMap,
	fillMissingCardtrader: options.fillMissingCardtrader,
	tcgplayerSetId: options.tcgplayerSetId,
	tcgplayerJson: options.tcgplayerJson,
	log: console.log,
}).catch((error) => {
	console.error('')
	console.error('Run failed:')
	console.error(error instanceof Error ? error.message : String(error))
	process.exitCode = 1
})

function parseArgs(args: string[]): CliOptions {
	const rawSetId = getArg(args, '--tcgplayer-set-id')

	return {
		repo: getArg(args, '--repo') ?? process.cwd(),
		set: getArg(args, '--set'),
		apply: args.includes('--apply'),
		help: args.includes('--help') || args.includes('-h'),
		fillMissingCardtrader: args.includes('--fill-missing-cardtrader'),
		cardmarketJson: getArg(args, '--cardmarket-json'),
		cardmarketMap: getArg(args, '--cardmarket-map'),
		tcgplayerSetId: rawSetId ? Number(rawSetId) : undefined,
		tcgplayerJson: getArg(args, '--tcgplayer-json'),
	}
}

function getArg(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag)

	if (idx === -1) {
		return undefined
	}

	const value = args[idx + 1]

	if (!value || value.startsWith('--')) {
		return undefined
	}

	return value
}

function printHelp(): void {
	console.log(`Usage:
  bun src/cli.ts --repo <path> --set <serie/set> [options]

Examples:
  bun src/cli.ts --repo H:/cards-database --set "Scarlet & Violet/Obsidian Flames"

  bun src/cli.ts --repo H:/cards-database --set "Scarlet & Violet/Obsidian Flames" --apply

  bun src/cli.ts --repo H:/cards-database --set "Scarlet & Violet/151" --fill-missing-cardtrader

  bun src/cli.ts --repo H:/cards-database --set "Scarlet & Violet/151" --fill-missing-cardtrader --apply

  bun src/cli.ts --repo H:/cards-database --set "Scarlet & Violet/Obsidian Flames" --cardmarket-json ./cardmarket-OBF-merged.json

  bun src/cli.ts --repo H:/cards-database --set "Scarlet & Violet/Obsidian Flames" --cardmarket-json ./cardmarket-OBF-merged.json --cardmarket-map ./cardmarket-OBF-merged.manual-map.json

Options:
  --repo <path>              Path to the cards-database repo.
                             Defaults to current directory.

  --set <set>                Set path inside data, for example:
                             "Scarlet & Violet/Obsidian Flames"

  --apply                    Write changes to card files.
                             Without this, the run is dry-run only.

  --fill-missing-cardtrader  Safe mode: only add missing cardtrader IDs to
                             existing detailed variants. Never converts simple
                             variants, never creates variants, never overwrites
                             existing IDs, never removes top-level thirdParty.

  --cardmarket-json <path>   Optional CardMarket merged export JSON from your
                             CardMarket script.

  --cardmarket-map <path>    Optional manual CardMarket variant mapping file.
                             If omitted, defaults to:
                             <cardmarket-json-name>.manual-map.json

  --tcgplayer-set-id <id>    Override the TCGPlayer set ID.
                             Use when the set file has no thirdParty.tcgplayer.

  --tcgplayer-json <path>    Path to a local TCGPlayer set JSON file.
                             Supported: TCGTracking API response or
                             sbf-tcgplayer-set-exporter format.

  --help, -h                 Show this help message.
`)
}