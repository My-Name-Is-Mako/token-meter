export type Live = { isActive: boolean; out: number }
export type Totals = { input: number; output: number; cacheRead: number; cacheWrite: number; steps: number }
export type Measure = {
  tokens: number | null
  window: number
  percent: number | null
  limits: { kind: string; percentUsed: number }[]
  usd: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'token-meter': { live: Live; totals: Totals; measure: Measure }
  }
}
