import fs from 'node:fs/promises'
import jscodeshift from 'jscodeshift'
import type { TCGTrackingProduct } from './types'

const j = jscodeshift.withParser('ts')

type BNode = { type: string; [k: string]: any }

interface ParsedVariant {
	fields: Array<{ name: string; rawValue: string }>   // non-thirdParty fields in source order
	thirdParty: Record<string, number>                  // existing IDs
}

/**
 * Returns new source with only the `variants` property updated.
 * All other file content is preserved byte-for-byte.
 */
export function buildVariants(source: string, products: TCGTrackingProduct[]): string {
	const range = findVariantsPropRange(source)
	if (!range) return source

	const propText = source.slice(range.start, range.end)
	const isDetailed = /^variants\s*:\s*\[/.test(propText)
	const baseIndent = lineIndent(source, range.start)

	let newPropText: string

	if (isDetailed) {
		const variants = parseVariantsArray(propText)
		newPropText = renderVariantsBlock(variants, products, baseIndent)
	} else {
		// Mode A — simple object, build fresh array
		newPropText = buildFreshVariantsBlock(products, baseIndent)
	}

	if (newPropText === propText) return source
	return source.slice(0, range.start) + newPropText + source.slice(range.end)
}

// ---------------------------------------------------------------------------
// Range finding — bracket-balanced, handles strings, no AST positions needed
// ---------------------------------------------------------------------------

function findVariantsPropRange(source: string): { start: number; end: number } | null {
	const match = source.match(/\bvariants\s*:/)
	if (!match || match.index === undefined) return null

	const keyStart = match.index
	const colonPos = source.indexOf(':', keyStart)
	let valueStart = colonPos + 1
	while (source[valueStart] === ' ' || source[valueStart] === '\t') valueStart++

	const open = source[valueStart]
	const close = open === '{' ? '}' : open === '[' ? ']' : null
	if (!close) return null

	let depth = 0
	let i = valueStart
	let inStr = false
	let strChar = ''

	while (i < source.length) {
		const c = source[i]
		if (inStr) {
			if (c === '\\') i++
			else if (c === strChar) inStr = false
		} else {
			if (c === '"' || c === "'" || c === '`') { inStr = true; strChar = c }
			else if (c === open) depth++
			else if (c === close) { depth--; if (depth === 0) return { start: keyStart, end: i + 1 } }
		}
		i++
	}
	return null
}

// ---------------------------------------------------------------------------
// Parse existing detailed variants array into structured data
// ---------------------------------------------------------------------------

function parseVariantsArray(propText: string): ParsedVariant[] {
	// Strip `variants: ` prefix to get just the array text
	const arrayText = propText.replace(/^variants\s*:\s*/, '')

	// Wrap in a variable so jscodeshift can parse it with correct short positions
	const wrapper = `const __v = ${arrayText}`
	const root = j(wrapper)

	const variants: ParsedVariant[] = []

	root.find(j.VariableDeclarator).forEach((p) => {
		const init = p.node.init as BNode
		if (init.type !== 'ArrayExpression') return

		for (const el of init.elements as BNode[]) {
			if (el.type !== 'ObjectExpression') continue

			const variant: ParsedVariant = { fields: [], thirdParty: {} }

			for (const prop of el.properties as BNode[]) {
				const name: string = prop.key?.name ?? prop.key?.value ?? ''
				if (!name) continue

				if (name === 'thirdParty') {
					for (const tp of (prop.value?.properties ?? []) as BNode[]) {
						const k: string = tp.key?.name ?? ''
						const v = tp.value?.value
						if (k && typeof v === 'number') variant.thirdParty[k] = v
					}
				} else {
					// Capture raw value as a string for faithful re-rendering
					variant.fields.push({ name, rawValue: rawValueOf(prop.value) })
				}
			}

			variants.push(variant)
		}
	})

	return variants
}

/** Serialise a Babel AST value node back to a TypeScript literal string. */
function rawValueOf(node: BNode): string {
	if (!node) return 'undefined'
	switch (node.type) {
		case 'StringLiteral': return `'${node.value}'`
		case 'NumericLiteral': return String(node.value)
		case 'BooleanLiteral': return String(node.value)
		case 'NullLiteral': return 'null'
		case 'ArrayExpression':
			return `[${(node.elements as BNode[]).map(rawValueOf).join(', ')}]`
		case 'ObjectExpression': {
			const pairs = (node.properties as BNode[]).map(
				(p) => `${p.key?.name ?? p.key?.value}: ${rawValueOf(p.value)}`,
			)
			return `{ ${pairs.join(', ')} }`
		}
		default: return 'undefined'
	}
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

function renderVariantsBlock(
	variants: ParsedVariant[],
	products: TCGTrackingProduct[],
	baseIndent: string,
): string {
	const byFinish = new Map<string, TCGTrackingProduct>()
	for (const p of products) {
		const f = normaliseFinish(p)
		if (f) byFinish.set(f, p)
	}

	const i1 = baseIndent + '\t'
	const i2 = i1 + '\t'
	const i3 = i2 + '\t'

	const elements = variants.map((variant) => {
		const finish = variant.fields.find((f) => f.name === 'type')?.rawValue?.replace(/'/g, '')

		const product =
			finish !== undefined
				? byFinish.get(finish)
				: products.length === 1 && variants.length === 1
				? products[0]
				: undefined

		const merged = { ...variant.thirdParty }
		if (product) {
			if (typeof product.cardmarket_id === 'number') merged.cardmarket ??= product.cardmarket_id
			merged.tcgplayer ??= product.id
			if (typeof product.cardtrader_id === 'number') merged.cardtrader ??= product.cardtrader_id
		}

		const lines: string[] = variant.fields.map((f) => `${i2}${f.name}: ${f.rawValue}`)

		if (Object.keys(merged).length > 0) {
			const tpFields = Object.entries(merged).map(([k, v]) => `${i3}${k}: ${v}`)
			lines.push(`${i2}thirdParty: {\n${tpFields.join(',\n')}\n${i2}}`)
		}

		return `${i1}{\n${lines.join(',\n')}\n${i1}}`
	})

	return `variants: [\n${elements.join(',\n')},\n${baseIndent}]`
}

function buildFreshVariantsBlock(products: TCGTrackingProduct[], baseIndent: string): string {
	const i1 = baseIndent + '\t'
	const i2 = i1 + '\t'
	const i3 = i2 + '\t'

	const elements = products.map((product) => {
		const finish = normaliseFinish(product)
		const lines: string[] = []
		if (finish) lines.push(`${i2}type: '${finish}'`)
		const tp = buildThirdPartyFields(product, i3)
		lines.push(`${i2}thirdParty: {\n${tp.join(',\n')}\n${i2}}`)
		return `${i1}{\n${lines.join(',\n')}\n${i1}}`
	})

	return `variants: [\n${elements.join(',\n')},\n${baseIndent}]`
}

function buildThirdPartyFields(product: TCGTrackingProduct, indent: string): string[] {
	const lines: string[] = []
	if (typeof product.cardmarket_id === 'number') lines.push(`${indent}cardmarket: ${product.cardmarket_id}`)
	lines.push(`${indent}tcgplayer: ${product.id}`)
	if (typeof product.cardtrader_id === 'number') lines.push(`${indent}cardtrader: ${product.cardtrader_id}`)
	return lines
}

function lineIndent(source: string, pos: number): string {
	const lineStart = source.lastIndexOf('\n', pos - 1) + 1
	const match = source.slice(lineStart, pos).match(/^(\s+)/)
	return match ? match[1] : '\t'
}

export function normaliseFinish(product: TCGTrackingProduct): string | null {
	const finish = (product.cardtrader ?? [])[0]?.finishes[0]
	if (finish) return finish
	const name = product.clean_name.toLowerCase()
	if (name.includes('reverse holo')) return 'reverse-holofoil'
	if (name.includes('holo')) return 'holofoil'
	return 'normal'
}

export async function writeCardFile(filePath: string, source: string): Promise<void> {
	await fs.writeFile(filePath, source, 'utf8')
}
