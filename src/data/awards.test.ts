import { describe, expect, it } from 'vitest'
import { AIRPORTS, PRICING, ROUTES, SEASON_CALENDARS, SOURCES, type Cabin, type SeasonGroup } from './awards'

describe('公式出典から収録した特典航空券データ', () => {
  it('全路線の空港・出典・料金・シーズンを参照でき、重複や同空港路線がない', () => {
    const airports = new Set(AIRPORTS.map(({ code }) => code))
    const sources = new Set(SOURCES.map(({ id }) => id))
    expect(airports.size).toBe(AIRPORTS.length)
    expect(sources.size).toBe(SOURCES.length)
    expect(new Set(ROUTES.map(({ id }) => id)).size).toBe(ROUTES.length)
    expect(new Set(ROUTES.map(({ origin, destination }) => `${origin}-${destination}`)).size).toBe(ROUTES.length)
    for (const route of ROUTES) {
      expect(airports.has(route.origin), route.id).toBe(true)
      expect(airports.has(route.destination), route.id).toBe(true)
      expect(route.origin, route.id).not.toBe(route.destination)
      expect(PRICING[route.pricingKey], route.id).toBeDefined()
      expect(SEASON_CALENDARS[route.seasonGroup], route.id).toBeDefined()
      expect(route.sourceIds.length, route.id).toBeGreaterThan(0)
      for (const source of route.sourceIds) expect(sources.has(source), `${route.id}: ${source}`).toBe(true)
    }
    for (const [key, cabins] of Object.entries(PRICING)) {
      expect(Object.keys(cabins).length, key).toBeGreaterThan(0)
      for (const chart of Object.values(cabins)) {
        for (const season of ['L', 'R', 'H'] as const) {
          expect(Number.isSafeInteger(chart[season]), `${key}: ${season}`).toBe(true)
          expect(chart[season], `${key}: ${season}`).toBeGreaterThan(0)
        }
      }
    }
  })

  it('公表期間の全日付をちょうど1シーズンで覆い、公表範囲外に拡張しない', () => {
    const end = '2028-03-31'
    for (const group of Object.keys(SEASON_CALENDARS) as SeasonGroup[]) {
      const start = group === 'domestic' ? '2026-05-19' : '2026-01-01'
      const ranges = SEASON_CALENDARS[group]
      for (const range of ranges) {
        expect(range.start >= start && range.start <= range.end && range.end <= end, group).toBe(true)
        for (const date of [range.start, range.end]) {
          expect(new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10), group).toBe(date)
        }
        expect(['L', 'R', 'H'], group).toContain(range.season)
      }
      for (let timestamp = Date.parse(`${start}T00:00:00Z`); timestamp <= Date.parse(`${end}T00:00:00Z`); timestamp += 86_400_000) {
        const date = new Date(timestamp).toISOString().slice(0, 10)
        expect(ranges.filter((range) => range.start <= date && date <= range.end), `${group}: ${date}`).toHaveLength(1)
      }
    }
  })

  it('国内4距離帯とソウル・北米の代表路線で最新の片道必要マイルを保持する', () => {
    // 公式国内1区間チャートと国際2025-06-24以降の片道チャートを独立した期待値にする。
    const examples: [string, string, Cabin, number, number, number][] = [
      ['HND-ITM', 'domestic-300', 'economy', 6000, 6500, 9000],
      ['HND-CTS', 'domestic-800', 'economy', 7000, 8500, 10500],
      ['HND-OKA', 'domestic-1000', 'economy', 8000, 9500, 12000],
      ['HND-ISG', 'domestic-2000', 'economy', 9500, 10500, 13000],
      ['HND-GMP', 'zone-2', 'economy', 6000, 7500, 12000],
      ['HND-GMP', 'zone-2', 'business', 18000, 20500, 25000],
      ['HND-LAX', 'zone-6', 'economy', 20000, 25000, 36000],
      ['HND-LAX', 'zone-6', 'premium', 31000, 36000, 50500],
      ['HND-LAX', 'zone-6', 'business', 50000, 52500, 82500],
      ['HND-LAX', 'zone-6', 'first', 75000, 85000, 150000],
    ]
    for (const [id, key, cabin, L, R, H] of examples) {
      expect(ROUTES.find((route) => route.id === id)?.pricingKey, id).toBe(key)
      expect(PRICING[key][cabin], `${id}: ${cabin}`).toEqual({ L, R, H })
    }
  })
})
