import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Hint, Live, Measure, Totals } from '../types'

const live = atom({ plugin: 'token-meter', key: 'live' } as const, { isActive: false, out: 0 } as Live)
const totals = atom(
  { plugin: 'token-meter', key: 'totals' } as const,
  { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, steps: 0 } as Totals,
)
const measure = atom(
  { plugin: 'token-meter', key: 'measure' } as const,
  { tokens: null, window: 0, percent: null, limits: [], usd: null } as Measure,
)

const hint = atom({ plugin: 'token-meter', key: 'hint' } as const, { level: 0, text: '' } as Hint)

// Elk bericht stuurt de hele chat opnieuw mee: hoe voller de context, hoe meer tokens
// en hoe trager elk volgend bericht. Daarom deze tips op vaste drempels.
function hintFor(percent: number): Hint {
  if (percent >= 85) {
    return { level: 3, text: 'Context bijna vol (' + Math.round(percent) + '%): start een nieuwe chat. Vraag eerst om een korte samenvatting om mee te nemen, of gebruik /compact.' }
  }
  if (percent >= 70) {
    return { level: 2, text: 'Context ' + Math.round(percent) + '% vol: /compact vat de chat samen en scheelt tokens per bericht.' }
  }
  if (percent >= 50) {
    return { level: 1, text: 'Context ' + Math.round(percent) + '% vol: houd berichten kort en plak geen grote bestanden meer in deze chat.' }
  }
  return { level: 0, text: '' }
}

const fmt = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n))

// ruwe schatting zolang de API nog geen echte telling geeft: ~4 tekens per token (Nederlands)
const estimate = (chars: number): number => Math.ceil(chars / 4)

async function refresh($: any): Promise<void> {
  const u = await $.session.usage()
  await update($, measure, () => ({
    tokens: u.context.tokens ?? null,
    window: u.context.window,
    percent: u.context.percent ?? null,
    limits: u.rateLimits.map((r: any) => ({ kind: r.kind, percentUsed: r.percentUsed })),
    usd: u.cost?.usd ?? null,
  }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await refresh($)
    } catch {}
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const nextHint = hintFor(e.context.percent ?? 0)
    const prev = await read($, hint)
    if (nextHint.level !== prev.level) {
      await update($, hint, () => nextHint)
      if (nextHint.level > prev.level) $.ui.toast(nextHint.text, { timeoutMs: 12000 })
    }
    await update($, measure, () => ({
      tokens: e.context.tokens ?? null,
      window: e.context.window,
      percent: e.context.percent ?? null,
      limits: e.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed })),
      usd: e.cost?.usd ?? null,
    }))
    return next(e)
  })

  // Realtime: elk stukje van het antwoord telt direct mee.
  on('turn.step', async function* ($, e, next) {
    let chars = 0
    let lastDraw = 0
    await update($, live, () => ({ isActive: true, out: 0 }))

    const stream = next(e)
    let result
    while (true) {
      const step = await stream.next()
      if (step.done) {
        result = step.value
        break
      }
      const c = step.value
      if (c.kind === 'text' || c.kind === 'thinking') chars += c.text.length
      else if (c.kind === 'input') chars += c.json.length
      else if (c.kind === 'stop' && c.usage) {
        const u = c.usage
        await update($, totals, t => ({
          input: t.input + u.input_tokens,
          output: t.output + u.output_tokens,
          cacheRead: t.cacheRead + u.cache_read_input_tokens,
          cacheWrite: t.cacheWrite + u.cache_creation_input_tokens,
          steps: t.steps + 1,
        }))
        await update($, live, () => ({ isActive: true, out: u.output_tokens }))
      }
      const now = await $.clock.now()
      if (now - lastDraw > 120) {
        lastDraw = now
        const est = estimate(chars)
        await update($, live, l => ({ isActive: true, out: Math.max(l.out, est) }))
      }
      yield c
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    await update($, live, l => ({ ...l, isActive: false }))
    try {
      await refresh($)
    } catch {}
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const l = await read($, live)
    const t = await read($, totals)
    const m = await read($, measure)
    const h = await read($, hint)

    const left = m.tokens !== null && m.window > 0 ? Math.max(0, m.window - m.tokens) : null
    const five = m.limits.find(r => r.kind === 'five_hour') ?? m.limits[0]

    return (
      <Box flexDirection="column">
        <Box>
        {l.isActive ? <Text color="yellow">⚡ ~{fmt(l.out)} out (live)  │  </Text> : null}
        <Text dimColor>
          sessie: {fmt(t.input + t.cacheRead + t.cacheWrite)} in · {fmt(t.output)} out
        </Text>
        {left !== null ? (
          <Text dimColor>
            {'  │  '}context over: {fmt(left)} ({100 - Math.round(m.percent ?? 0)}%)
          </Text>
        ) : null}
        {five ? (
          <Text dimColor>
            {'  │  '}{five.kind === 'five_hour' ? '5u-limiet' : five.kind}: {Math.round(100 - five.percentUsed)}% over
          </Text>
        ) : null}
        {m.usd !== null ? <Text dimColor>{'  │  '}${m.usd.toFixed(2)}</Text> : null}
        </Box>
        {h.level > 0 ? <Text color={h.level >= 3 ? 'red' : 'yellow'}>💡 {h.text}</Text> : null}
      </Box>
    )
  })
}
