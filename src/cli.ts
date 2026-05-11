import { runEnrichment } from './enrichment'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const repoArg = getArg('--repo') ?? process.cwd()
const setArg = getArg('--set')

if (!setArg) {
	console.error('Usage: bun src/cli.ts --repo <path> --set <serie/set> [--apply]')
	console.error('Example: bun src/cli.ts --repo H:/cards-database --set EX/FireRed-LeafGreen')
	process.exitCode = 1
	process.exit()
}

await runEnrichment({ repo: repoArg, set: setArg, apply, log: console.log }).catch((error) => {
	console.error(error instanceof Error ? error.message : String(error))
	process.exitCode = 1
})

function getArg(flag: string): string | undefined {
	const idx = args.indexOf(flag)
	return idx !== -1 ? args[idx + 1] : undefined
}
