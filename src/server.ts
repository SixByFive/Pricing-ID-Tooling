import path from 'node:path'
import fs from 'node:fs/promises'
import { listSets, runEnrichment } from './enrichment'

const PORT = Number(process.env.PORT ?? 3001)
const PUBLIC_DIR = path.join(import.meta.dir, '..', 'public')

Bun.serve({
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url)

		// Static UI
		if (url.pathname === '/' || url.pathname === '/index.html') {
			const file = Bun.file(path.join(PUBLIC_DIR, 'index.html'))
			return new Response(file, { headers: { 'Content-Type': 'text/html' } })
		}

		// GET /api/sets?repo=<path>
		if (url.pathname === '/api/sets' && req.method === 'GET') {
			const repo = url.searchParams.get('repo') ?? ''

			if (!repo) {
				return json({ error: 'repo is required' }, 400)
			}

			const sets = await listSets(repo)
			return json({ sets })
		}

		// POST /api/run  body: { repo, set, apply }
		// Returns: text/event-stream (SSE)
		if (url.pathname === '/api/run' && req.method === 'POST') {
			const body = await req.json() as { repo?: string; set?: string; apply?: boolean }

			if (!body.repo || !body.set) {
				return json({ error: 'repo and set are required' }, 400)
			}

			const stream = new ReadableStream({
				async start(controller) {
					const enc = (data: string) =>
						controller.enqueue(new TextEncoder().encode(data))

					const sendLine = (line: string) => {
						enc(`data: ${JSON.stringify({ type: 'log', line })}\n\n`)
					}

					try {
						const report = await runEnrichment({
							repo: body.repo!,
							set: body.set!,
							apply: body.apply ?? false,
							log: sendLine,
						})

						enc(`data: ${JSON.stringify({ type: 'done', report })}\n\n`)
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error)
						enc(`data: ${JSON.stringify({ type: 'error', message })}\n\n`)
					} finally {
						controller.close()
					}
				},
			})

			return new Response(stream, {
				headers: {
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-cache',
					'Connection': 'keep-alive',
					'Access-Control-Allow-Origin': '*',
				},
			})
		}

		// GET /api/report?set=<slug>
		if (url.pathname === '/api/report' && req.method === 'GET') {
			const set = url.searchParams.get('set') ?? ''
			const slug = set.replace(/[/\\]/g, '-')
			const reportFile = path.join(process.cwd(), 'var', 'reports', `enrichment-${slug}.json`)

			try {
				const raw = await fs.readFile(reportFile, 'utf8')
				return new Response(raw, { headers: { 'Content-Type': 'application/json' } })
			} catch {
				return json({ error: 'No report found for this set' }, 404)
			}
		}

		return json({ error: 'Not found' }, 404)
	},
})

console.log(`Pricing-ID Tooling UI: http://localhost:${PORT}`)

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}
