import path from 'node:path'
import fs from 'node:fs/promises'
import {
	clearCardmarketBaseOverride,
	loadCardmarketMergeContext,
	removeCardmarketManualMapping,
	saveCardmarketManualMap,
	setCardmarketBaseOverride,
	setCardmarketManualMapping,
	type CardmarketManualVariant,
} from './cardmarket-merge'
import { listSets, runEnrichment } from './enrichment'
import { linkSetFromCatalog } from './cardmarket-catalog-linker'

const PORT = Number(process.env.PORT ?? 3001)
const PUBLIC_DIR = path.join(import.meta.dir, '..', 'public')
const REPORTS_DIR = path.join(process.cwd(), 'var', 'reports')

Bun.serve({
	port: PORT,

	async fetch(req: Request) {
		const url = new URL(req.url)

		try {
			// -----------------------------------------------------------------
			// Static UI
			// -----------------------------------------------------------------

			if (url.pathname === '/' || url.pathname === '/index.html') {
				return serveStaticFile('index.html', 'text/html; charset=utf-8')
			}

			if (url.pathname.startsWith('/assets/')) {
				return serveStaticFile(url.pathname.replace(/^\/+/, ''))
			}

			// -----------------------------------------------------------------
			// API: list sets
			// -----------------------------------------------------------------
			// GET /api/sets?repo=<path>

			if (url.pathname === '/api/sets' && req.method === 'GET') {
				const repo = url.searchParams.get('repo')?.trim() ?? ''

				if (!repo) {
					return json({ error: 'repo is required' }, 400)
				}

				const sets = await listSets(repo)

				return json({ sets })
			}

			// -----------------------------------------------------------------
			// API: upload a local JSON file
			// -----------------------------------------------------------------
			// POST /api/upload  (multipart/form-data, field: file)
			// Saves the file to var/uploads/ and returns its absolute path.

			if (url.pathname === '/api/upload' && req.method === 'POST') {
				const form = await req.formData()
				const file = form.get('file')

				if (!file || !(file instanceof File)) {
					return json({ error: 'file field is required' }, 400)
				}

				const uploadsDir = path.join(process.cwd(), 'var', 'uploads')
				await fs.mkdir(uploadsDir, { recursive: true })

				const destPath = path.join(uploadsDir, file.name)
				await Bun.write(destPath, file)

				return json({ path: destPath })
			}

			// -----------------------------------------------------------------
			// API: run enrichment
			// -----------------------------------------------------------------
			// POST /api/run
			// body: { repo, set, apply, cardmarketJson?, cardmarketMap? }
			// returns: text/event-stream

			if (url.pathname === '/api/run' && req.method === 'POST') {
				const body = await readJsonBody<{
					repo?: string
					set?: string
					apply?: boolean
					cardmarketJson?: string
					cardmarketMap?: string
					fillMissingCardtrader?: boolean
					tcgplayerSetId?: number
					tcgplayerJson?: string
					tcgplayerIdMap?: string
				}>(req)

				if (!body.ok) {
					return json({ error: body.error }, 400)
				}

				const repo = body.data.repo?.trim() ?? ''
				const set = body.data.set?.trim() ?? ''
				const apply = body.data.apply ?? false
				const cardmarketJson = body.data.cardmarketJson?.trim() || undefined
				const cardmarketMap = body.data.cardmarketMap?.trim() || undefined
				const fillMissingCardtrader = body.data.fillMissingCardtrader ?? false
				const tcgplayerSetId =
					typeof body.data.tcgplayerSetId === 'number' ? body.data.tcgplayerSetId : undefined
				const tcgplayerJson = body.data.tcgplayerJson?.trim() || undefined
				const tcgplayerIdMap = body.data.tcgplayerIdMap?.trim() || undefined

				if (!repo || !set) {
					return json({ error: 'repo and set are required' }, 400)
				}

				const stream = new ReadableStream({
					async start(controller) {
						const encoder = new TextEncoder()

						const send = (payload: unknown) => {
							controller.enqueue(
								encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
							)
						}

						const sendLine = (line: string) => {
							send({
								type: 'log',
								line,
							})
						}

						try {
							sendLine(`Starting ${apply ? 'apply' : 'dry-run'}...`)

							const report = await runEnrichment({
								repo,
								set,
								apply,
								cardmarketJson,
								cardmarketMap,
								fillMissingCardtrader,
								tcgplayerSetId,
								tcgplayerJson,
								tcgplayerIdMap,
								log: sendLine,
							})

							send({
								type: 'done',
								report,
							})
						} catch (error) {
							const message = error instanceof Error ? error.message : String(error)

							send({
								type: 'error',
								message,
							})
						} finally {
							controller.close()
						}
					},
				})

				return new Response(stream, {
					headers: {
						'Content-Type': 'text/event-stream; charset=utf-8',
						'Cache-Control': 'no-cache, no-transform',
						Connection: 'keep-alive',
						'X-Accel-Buffering': 'no',
					},
				})
			}

			// -----------------------------------------------------------------
			// API: save/remove CardMarket manual mapping
			// -----------------------------------------------------------------
			// POST /api/cardmarket-map
			// body:
			// {
			//   cardmarketJson: string,
			//   cardmarketMap?: string,
			//   cardId: string,
			//   productId: number,
			//   variant?: { type, foil?, stamp?, notes? }
			// }
			//
			// If variant is omitted/null, the mapping is removed.

			if (url.pathname === '/api/cardmarket-map' && req.method === 'POST') {
				const body = await readJsonBody<{
					cardmarketJson?: string
					cardmarketMap?: string
					cardId?: string
					productId?: number
					variant?: CardmarketManualVariant | null
					/**
					 * Set productId as the base (auto-mapped) product for this card.
					 * Mutually exclusive with variant and clearBase.
					 */
					setBase?: boolean
					/**
					 * Clear any base override for this card, restoring the bucket default.
					 * When true, productId is ignored.
					 */
					clearBase?: boolean
				}>(req)

				if (!body.ok) {
					return json({ error: body.error }, 400)
				}

				const cardmarketJson = body.data.cardmarketJson?.trim() ?? ''
				const cardmarketMap = body.data.cardmarketMap?.trim() || undefined
				const cardId = body.data.cardId?.trim() ?? ''
				const productId = body.data.productId
				const setBase = body.data.setBase ?? false
				const clearBase = body.data.clearBase ?? false

				if (!cardmarketJson || !cardId) {
					return json({ error: 'cardmarketJson and cardId are required' }, 400)
				}

				if (!setBase && !clearBase && typeof productId !== 'number') {
					return json({ error: 'productId is required for variant operations' }, 400)
				}

				const context = await loadCardmarketMergeContext(cardmarketJson, cardmarketMap)

				if (!context) {
					return json({ error: 'Could not load CardMarket merge context' }, 400)
				}

				let nextMapping = context.mapping

				if (clearBase) {
					nextMapping = clearCardmarketBaseOverride(nextMapping, cardId)
				} else if (setBase && typeof productId === 'number') {
					nextMapping = setCardmarketBaseOverride(nextMapping, cardId, productId)
				} else if (body.data.variant) {
					nextMapping = setCardmarketManualMapping(
						nextMapping,
						cardId,
						productId as number,
						body.data.variant,
					)
				} else {
					nextMapping = removeCardmarketManualMapping(
						nextMapping,
						cardId,
						productId as number,
					)
				}

				await saveCardmarketManualMap(context.mappingPath, nextMapping)

				return json({
					ok: true,
					mappingPath: context.mappingPath,
					mapping: nextMapping,
				})
			}

			// -----------------------------------------------------------------
			// API: link a set's CardMarket IDs from the official product catalog
			// -----------------------------------------------------------------
			// POST /api/cardmarket-catalog-link
			// body: { repo: string, set: string }
			// Read-only against the card-data repo; writes a merge JSON to
			// var/cm-exports/. No network calls to CardMarket — uses the
			// already-downloaded official product catalog (var/cardmarket/products_singles.json).

			if (url.pathname === '/api/cardmarket-catalog-link' && req.method === 'POST') {
				const body = await readJsonBody<{ repo?: string; set?: string }>(req)

				if (!body.ok) {
					return json({ error: body.error }, 400)
				}

				const repo = body.data.repo?.trim() ?? ''
				const set = body.data.set?.trim() ?? ''

				if (!repo || !set) {
					return json({ error: 'repo and set are required' }, 400)
				}

				const setDir = path.join(repo, 'data', set)
				const outDir = path.join(process.cwd(), 'var', 'cm-exports')

				try {
					const result = await linkSetFromCatalog({ setDir, outDir })

					return json({ ok: true, ...result })
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error)
					return json({ error: message }, 400)
				}
			}

			// -----------------------------------------------------------------
			// API: save/remove a TCGPlayer ID override entry
			// -----------------------------------------------------------------
			// POST /api/tcgplayer-id-map
			// body: { mapPath?: string, set?: string, cardKey: string, productId: number | null }
			// If productId is null, the entry is removed.
			// If mapPath is omitted, an auto path is created from set slug under var/maps/.
			// Returns: { mapPath, map }

			if (url.pathname === '/api/tcgplayer-id-map' && req.method === 'POST') {
				const body = await readJsonBody<{
					mapPath?: string
					set?: string
					cardKey?: string
					productId?: number | null
				}>(req)

				if (!body.ok) {
					return json({ error: body.error }, 400)
				}

				const cardKey = body.data.cardKey?.trim() ?? ''

				if (!cardKey) {
					return json({ error: 'cardKey is required' }, 400)
				}

				let mapPath = body.data.mapPath?.trim() || undefined

				if (!mapPath) {
					const slug = (body.data.set ?? 'default').replace(/[/\\]/g, '-')
					const mapsDir = path.join(process.cwd(), 'var', 'maps')
					await fs.mkdir(mapsDir, { recursive: true })
					mapPath = path.join(mapsDir, `tcgplayer-id-map-${slug}.json`)
				}

				let map: Record<string, number> = {}

				try {
					map = JSON.parse(await fs.readFile(mapPath, 'utf8'))
				} catch {
					// File doesn't exist yet — start fresh.
				}

				const productId = body.data.productId

				if (productId === null || productId === undefined) {
					delete map[cardKey]
				} else {
					map[cardKey] = productId
				}

				await fs.writeFile(mapPath, `${JSON.stringify(map, null, '\t')}\n`, 'utf8')

				return json({ mapPath, map })
			}

			// -----------------------------------------------------------------
			// API: latest report for selected set
			// -----------------------------------------------------------------
			// GET /api/report?set=<slug>

			if (url.pathname === '/api/report' && req.method === 'GET') {
				const set = url.searchParams.get('set')?.trim() ?? ''

				if (!set) {
					return json({ error: 'set is required' }, 400)
				}

				const reportFile = getReportFilePath(set)

				try {
					const raw = await fs.readFile(reportFile, 'utf8')

					return new Response(raw, {
						headers: {
							'Content-Type': 'application/json; charset=utf-8',
							'Cache-Control': 'no-store',
						},
					})
				} catch (error) {
					if (isNodeError(error) && error.code === 'ENOENT') {
						return json({ error: 'No report found for this set' }, 404)
					}

					throw error
				}
			}

			return json({ error: 'Not found' }, 404)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)

			console.error(error)

			return json(
				{
					error: 'Internal server error',
					message,
				},
				500,
			)
		}
	},
})

console.log(`Pricing-ID Tooling UI: http://localhost:${PORT}`)

// ---------------------------------------------------------------------------
// Static file helpers
// ---------------------------------------------------------------------------

function serveStaticFile(filePath: string, contentType?: string): Response {
	const safePath = normalisePublicPath(filePath)
	const absolutePath = path.join(PUBLIC_DIR, safePath)
	const file = Bun.file(absolutePath)

	return new Response(file, {
		headers: {
			'Content-Type': contentType ?? getContentType(absolutePath),
			'Cache-Control': 'no-store',
		},
	})
}

/**
 * Prevent accidental path traversal through static file requests.
 */
function normalisePublicPath(filePath: string): string {
	return filePath
		.replace(/^\/+/, '')
		.replaceAll('\\', '/')
		.split('/')
		.filter((part) => part && part !== '.' && part !== '..')
		.join('/')
}

function getContentType(filePath: string): string {
	const ext = path.extname(filePath).toLowerCase()

	switch (ext) {
		case '.html':
			return 'text/html; charset=utf-8'
		case '.css':
			return 'text/css; charset=utf-8'
		case '.js':
			return 'application/javascript; charset=utf-8'
		case '.json':
			return 'application/json; charset=utf-8'
		case '.svg':
			return 'image/svg+xml'
		case '.png':
			return 'image/png'
		case '.jpg':
		case '.jpeg':
			return 'image/jpeg'
		case '.webp':
			return 'image/webp'
		case '.ico':
			return 'image/x-icon'
		default:
			return 'application/octet-stream'
	}
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function readJsonBody<T>(req: Request): Promise<
	| {
			ok: true
			data: T
	  }
	| {
			ok: false
			error: string
	  }
> {
	try {
		const data = (await req.json()) as T

		return {
			ok: true,
			data,
		}
	} catch {
		return {
			ok: false,
			error: 'Invalid JSON body',
		}
	}
}

function json(data: unknown, status = 200): Response {
	return new Response(`${JSON.stringify(data, null, '\t')}\n`, {
		status,
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			'Cache-Control': 'no-store',
		},
	})
}

function getReportFilePath(set: string): string {
	const slug = set.replace(/[/\\]/g, '-')

	return path.join(REPORTS_DIR, `enrichment-${slug}.json`)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error
}