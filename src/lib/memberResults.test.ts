import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemberItinerary, MemberQuery } from './anaMember'
import { memberHasSeats, memberQueries, readMemberRows, validMemberQuery } from './memberResults'
import { addDays, defaults, type SearchFilters } from './search'

const today = '2026-09-23'
const query: MemberQuery = {
  origin: 'TYO', destination: 'HNL', departureDate: addDays(today, 30),
  returnDate: addDays(today, 33), cabin: 'economy', passengers: 2,
}
const checkedAt = `${today}T03:00:00.000Z`

function filters(overrides: Partial<SearchFilters> = {}): SearchFilters {
  return {
    ...defaults(today), kind: 'international', origin: 'TYO', region: 'ハワイ',
    dateFrom: query.departureDate, dateTo: query.departureDate, cabin: 'economy',
    passengers: 2, budget: 80_000, ...overrides,
  }
}

function itinerary(): MemberItinerary {
  return {
    outbound: [{ flightNumber: 'NH186', origin: 'HND', destination: 'HNL', date: query.departureDate, bookingClass: 'X' }],
    inbound: [{ flightNumber: 'NH185', origin: 'HNL', destination: 'HND', date: query.returnDate, bookingClass: 'X' }],
    outboundSeats: 3, inboundSeats: 2, totalMiles: 80_000, totalCashJpy: 58_640,
  }
}

function reply(overrides: Record<string, unknown> = {}) {
  return { query, checkedAt, source: 'ana-member', partial: true, itineraries: [itinerary()], ...overrides }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(checkedAt))
})
afterEach(() => vi.useRealTimers())

describe('会員検索の照会範囲', () => {
  it('最大62日と復路355日先の境界を守り、期間を欠落・重複なく日単位へ展開する', () => {
    const input = filters({ dateTo: addDays(query.departureDate, 61) })
    const queries = memberQueries(input, query)
    expect(queries).toHaveLength(62)
    expect(new Set(queries.map(q => q.departureDate)).size).toBe(62)
    expect(queries[0]).toEqual(query)
    expect(queries.at(-1)).toEqual({ ...query, departureDate: input.dateTo, returnDate: addDays(input.dateTo, 3) })
    expect(memberQueries({ ...input, dateTo: addDays(input.dateTo, 1) }, query)).toEqual([])
    const last = filters({ dateFrom: addDays(today, 352), dateTo: addDays(today, 352) })
    expect(memberQueries(last, query)[0].returnDate).toBe(addDays(today, 355))
    expect(memberQueries({ ...last, nights: 4 }, query)).toEqual([])
  })

  it('未接続・未対応条件・接続区間以外の条件では照会を生成しない', () => {
    expect(memberQueries(filters(), null)).toEqual([])
    for (const change of [
      { kind: 'domestic' as const }, { tripType: 'oneway' as const }, { cabin: 'business' as const },
      { origin: 'KIX' }, { region: 'ヨーロッパ' }, { passengers: 0 },
    ]) expect(memberQueries(filters(change), query)).toEqual([])
    expect(memberQueries(filters({ origin: 'ALL', region: 'all' }), query)).toEqual([query])
    for (const change of [
      { departureDate: '2026-02-30' }, { returnDate: query.departureDate },
      { origin: 'HNL', destination: 'TYO' }, { cabin: 'business' }, { passengers: 1.5 },
    ]) expect(validMemberQuery({ ...query, ...change })).toBe(false)
  })
})

describe('会員結果の入力検証', () => {
  it('不明・文字列・小数・負数の席数や料金を0へ補完せず拒否する', () => {
    for (const field of ['outboundSeats', 'inboundSeats', 'totalMiles', 'totalCashJpy']) {
      for (const bad of [undefined, null, '2', 0.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => readMemberRows(reply({ itineraries: [{ ...itinerary(), [field]: bad }] }), query)).toThrow('席数・料金')
      }
    }
    expect(() => readMemberRows(reply({ itineraries: [{ ...itinerary(), totalMiles: 0 }] }), query)).toThrow('席数・料金')
    expect(() => readMemberRows(reply({ itineraries: [{ ...itinerary(), inboundSeats: 100 }] }), query)).toThrow('席数・料金')
  })

  it('未知の空席待ち状態・空配列・片側欠落・不明な確認時刻を正常な空席なしとして扱わない', () => {
    for (const itineraries of [
      [], [{ ...itinerary(), inbound: [] }],
      [{ ...itinerary(), inboundWaitlist: 'false' }],
      [{ ...itinerary(), outbound: [...itinerary().outbound, ...itinerary().outbound] }],
      Array.from({ length: 501 }, itinerary),
    ]) expect(() => readMemberRows(reply({ itineraries }), query)).toThrow()
    expect(() => readMemberRows(reply({ checkedAt: 'unknown' }), query)).toThrow()
    expect(() => readMemberRows(reply({ partial: false }), query)).toThrow()
  })

  it('明示の0席と不足席を保持し、待ち状態の正数を人数充足とせず、未知の追加情報を保存しない', () => {
    const rows = readMemberRows(reply({ itineraries: [
      { ...itinerary(), token: 'fixture-only', outbound: [{ ...itinerary().outbound[0], extra: 'fixture-only' }] },
      { ...itinerary(), inboundSeats: 0, inboundWaitlist: true },
      { ...itinerary(), inboundSeats: 1 },
      { ...itinerary(), inboundWaitlist: true },
    ] }), query)
    expect(rows.map(row => [row.inboundSeats, memberHasSeats(row)])).toEqual([[2, true], [0, false], [1, false], [2, false]])
    expect(rows[0].totalMiles).toBe(80_000)
    expect(rows[0].totalCashJpy).toBe(58_640)
    expect(rows[0]).not.toHaveProperty('token')
    expect(rows[0].outbound[0]).not.toHaveProperty('extra')
  })
})
