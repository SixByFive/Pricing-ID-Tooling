import { runEnrichment } from './enrichment'

interface CliOptions {
	repo: string
	set?: string
	apply: boolean
	help: boolean

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
console.log(`Mode: ${options.apply ? 'apply' : 'dry-run'}`)
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
	log: console.log,
}).catch((error) => {
	console.error('')
	console.error('Run failed:')
	console.error(error instanceof Error ? error.message : String(error))
	process.exitCode = 1
})

function parseArgs(args: string[]): CliOptions {
	return {
		repo: getArg(args, '--repo') ?? process.cwd(),
		set: getArg(args, '--set'),
		apply: args.includes('--apply'),
		help: args.includes('--help') || args.includes('-h'),
		cardmarketJson: getArg(args, '--cardmarket-json'),
		cardmarketMap: getArg(args, '--cardmarket-map'),
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

  bun src/cli.ts --repo H:/cards-database --set "Scarlet & Violet/Obsidian Flames" --cardmarket-json ./cardmarket-OBF-merged.json

  bun src/cli.ts --repo H:/cards-database --set "Scarlet & Violet/Obsidian Flames" --cardmarket-json ./cardmarket-OBF-merged.json --cardmarket-map ./cardmarket-OBF-merged.manual-map.json

Options:
  --repo <path>              Path to the cards-database repo.
                             Defaults to current directory.

  --set <set>                Set path inside data, for example:
                             "Scarlet & Violet/Obsidian Flames"

  --apply                    Write changes to card files.
                             Without this, the run is dry-run only.

  --cardmarket-json <path>   Optional CardMarket merged export JSON from your
                             CardMarket script.

  --cardmarket-map <path>    Optional manual CardMarket variant mapping file.
                             If omitted, defaults to:
                             <cardmarket-json-name>.manual-map.json

  --help, -h                 Show this help message.
`)
}