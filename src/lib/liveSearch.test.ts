import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnaChatOffer } from './anaChat'
import { buildAvailabilityQueries, filterLiveOffers, filterOffersForQuery, pairRoundtripOffers } from './liveSearch'
import { addDays, defaults, searchAwards, type SearchFilters } from './search'

const today = '2026-09-22'
function filters(overrides: Partial<SearchFilters> = {}): SearchFilters {
  return {
    ...defaults(today),
    kind: 'international',
    origin: 'TYO',
    region: 'ハワイ',
    dateFrom: '2026-10-01',
    dateTo: '2026-10-15',
    tripType: 'oneway',
    budget: 100_000,
    ...overrides,
  }
}

function offer(overrides: Partial<AnaChatOffer> = {}): AnaChatOffer {
  return {
    flightNumber: 'NH186', originLabel: '東京(羽田)', destinationLabel: 'ホノルル(オアフ島)',
    date: '2026-10-01', time: '21:30', cabin: 'economy', seats: 3,
    source: 'ana-public-chat', accountScope: 'anonymous', ...overrides,
  }
}

function returnOffer(overrides: Partial<AnaChatOffer> = {}): AnaChatOffer {
  return offer({
    flightNumber: 'NH185', originLabel: 'ホノルル(オアフ島)', destinationLabel: '東京(羽田)',
    date: '2026-10-04', time: '13:30', ...overrides,
  })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-22T03:00:00.000Z'))
})
afterEach(() => vi.useRealTimers())

describe('空席照会の組み立て', () => {
  it('東京の両空港をまとめ、7日境界を重複・欠落なしで分割する', () => {
    const input = filters()
    expect(buildAvailabilityQueries(searchAwards(input, today).results, input)).toEqual([
      { origin: 'TYO', destination: 'HNL', dateFrom: '2026-10-01', dateTo: '2026-10-07' },
      { origin: 'TYO', destination: 'HNL', dateFrom: '2026-10-08', dateTo: '2026-10-14' },
      { origin: 'TYO', destination: 'HNL', dateFrom: '2026-10-15', dateTo: '2026-10-15' },
    ])
    const full = filters({ dateTo: addDays(input.dateFrom, 61) })
    const queries = buildAvailabilityQueries(searchAwards(full, today).results, full)
    expect(queries).toHaveLength(9)
    expect(queries.at(-1)?.dateTo).toBe(full.dateTo)
  })

  it('最低4日後を含め、期間上限を守り、国内線や旅程種別が違う候補を照会しない', () => {
    const input = filters({ dateFrom: today, dateTo: '2026-09-30' })
    expect(buildAvailabilityQueries(searchAwards(input, today).results, input)[0]).toEqual({
      origin: 'TYO', destination: 'HNL', dateFrom: '2026-09-26', dateTo: '2026-09-30',
    })
    for (const overrides of [
      { dateTo: '2026-09-25' }, { dateFrom: addDays(today, 355), dateTo: addDays(today, 356) },
      { tripType: 'roundtrip' as const }, { kind: 'domestic' as const },
    ]) {
      expect(buildAvailabilityQueries(searchAwards(input, today).results, filters({ ...input, ...overrides }))).toEqual([])
    }
  })

  it('個別空港・目的地選択を守り、予算内候補がない照会を生成しない', () => {
    const input = filters({ origin: 'ALL', region: 'all', dateTo: '2026-10-01' })
    const results = searchAwards(input, today).results
    const queries = buildAvailabilityQueries(results, input, 'HNL')
    expect(queries.map(query => query.origin).sort()).toEqual(['HND', 'NRT'])
    expect(queries.every(query => query.destination === 'HNL')).toBe(true)
    expect(buildAvailabilityQueries(results, { ...input, origin: 'HND' }, 'HNL')).toHaveLength(1)
    expect(buildAvailabilityQueries(results, { ...input, budget: 1 }, 'HNL')).toEqual([])
    expect(buildAvailabilityQueries(results, input, 'UNKNOWN')).toEqual([])
  })

  it('往復の東京まとめ照会を両方向で7日ずつ生成し、APIの4キー以外を追加しない', () => {
    const input = filters({ tripType: 'roundtrip', nights: 3 })
    const queries = buildAvailabilityQueries(searchAwards(input, today).results, input)
    expect(queries).toEqual([
      { origin: 'TYO', destination: 'HNL', dateFrom: '2026-10-01', dateTo: '2026-10-07' },
      { origin: 'TYO', destination: 'HNL', dateFrom: '2026-10-08', dateTo: '2026-10-14' },
      { origin: 'TYO', destination: 'HNL', dateFrom: '2026-10-15', dateTo: '2026-10-15' },
      { origin: 'HNL', destination: 'TYO', dateFrom: '2026-10-04', dateTo: '2026-10-10' },
      { origin: 'HNL', destination: 'TYO', dateFrom: '2026-10-11', dateTo: '2026-10-17' },
      { origin: 'HNL', destination: 'TYO', dateFrom: '2026-10-18', dateTo: '2026-10-18' },
    ])
    expect(queries.every(query => Object.keys(query).sort().join(',') === 'dateFrom,dateTo,destination,origin')).toBe(true)
    expect(new Set(queries.map(query => JSON.stringify(query))).size).toBe(6)
  })

  it('年をまたぐ復路期間を現地出発日のまま7日分割する', () => {
    const input = filters({ tripType: 'roundtrip', nights: 5, dateFrom: '2026-12-28', dateTo: '2027-01-05' })
    const queries = buildAvailabilityQueries(searchAwards(input, today).results, input)
    expect(queries.filter(query => query.origin === 'HNL')).toEqual([
      { origin: 'HNL', destination: 'TYO', dateFrom: '2027-01-02', dateTo: '2027-01-08' },
      { origin: 'HNL', destination: 'TYO', dateFrom: '2027-01-09', dateTo: '2027-01-10' },
    ])
  })

  it('往復総予算を再検証し、予算を超える場合はどちらの方向も照会しない', () => {
    const input = filters({ tripType: 'roundtrip', passengers: 2, budget: 80_000, dateTo: '2026-10-01' })
    const results = searchAwards(input, today).results
    expect(buildAvailabilityQueries(results, input)).toHaveLength(2)
    expect(buildAvailabilityQueries(results, { ...input, budget: 79_999 })).toEqual([])
    expect(buildAvailabilityQueries(results, { ...input, passengers: 3 })).toEqual([])
    const haneda = { ...input, origin: 'HND' }
    expect(buildAvailabilityQueries(results, haneda).map(query => [query.origin, query.destination])).toEqual([
      ['HND', 'HNL'], ['HNL', 'HND'],
    ])
  })

  it('予算内の候補日がない7日間を飛ばし、往復で空の照会を増やさない', () => {
    const input = filters({ tripType: 'roundtrip' })
    const results = searchAwards(input, today).results.map(result => ({
      ...result, options: result.options.filter(option => option.departureDate === '2026-10-15'),
    }))
    expect(buildAvailabilityQueries(results, input)).toEqual([
      { origin: 'TYO', destination: 'HNL', dateFrom: '2026-10-15', dateTo: '2026-10-15' },
      { origin: 'HNL', destination: 'TYO', dateFrom: '2026-10-18', dateTo: '2026-10-18' },
    ])
  })
})

describe('空席回答と検索条件の対応', () => {
  it('全員分の予算を計算し、0席や人数不足を消さず保持する', () => {
    const input = filters({ passengers: 2, budget: 40_000 })
    const results = searchAwards(input, today).results
    const offers = [offer({ seats: 0 }), offer({ seats: 1 }), offer({ seats: 2 })]
    const matches = filterLiveOffers(offers, results, input)
    expect(matches.map(match => match.totalMiles)).toEqual([40_000, 40_000, 40_000])
    expect(matches.map(match => match.offer.seats)).toEqual([0, 1, 2])
    expect(filterLiveOffers(offers, results, { ...input, budget: 39_999 })).toEqual([])
    expect(filterLiveOffers(offers, results, { ...input, passengers: 3 })).toEqual([])
  })

  it('全半角を正規化し、別空港・都市名だけの曖昧な区間・他社便を拒否する', () => {
    const input = filters({ origin: 'HND' })
    const results = searchAwards(input, today).results
    const correct = offer({ originLabel: ' 東京（羽田） ', destinationLabel: 'ホノルル' })
    expect(filterLiveOffers([correct], results, input)).toHaveLength(1)
    const wrong = [
      offer({ originLabel: '東京(成田)' }), offer({ originLabel: '東京' }),
      offer({ destinationLabel: 'ホノルル空港' }), offer({ destinationLabel: 'ロサンゼルス' }),
      offer({ flightNumber: 'UA186' }), offer({ flightNumber: 'NH186X' }),
    ]
    expect(filterLiveOffers(wrong, results, input)).toEqual([])
    const narita = filters({ origin: 'NRT' })
    expect(filterLiveOffers([offer({ originLabel: '東京(成田)' })], searchAwards(narita, today).results, narita)).toHaveLength(1)
  })

  it('期間・候補日・クラスが違う回答と不正席数を採用しない', () => {
    const input = filters({ dateTo: '2026-10-02' })
    const results = searchAwards(input, today).results.map(result => ({
      ...result, options: result.options.filter(option => option.departureDate === '2026-10-01'),
    }))
    const wrong = [
      offer({ date: '2026-09-30' }), offer({ date: '2026-10-03' }), offer({ date: '2026-10-02' }),
      offer({ cabin: 'business' }), offer({ seats: -1 }), offer({ seats: Number.NaN }),
    ]
    expect(filterLiveOffers(wrong, results, input)).toEqual([])
    expect(filterLiveOffers([offer()], results, { ...input, tripType: 'roundtrip' })).toEqual([])
  })
})

describe('個別照会の回答照合', () => {
  const query = { origin: 'HNL', destination: 'TYO', dateFrom: '2026-10-04', dateTo: '2026-10-06' }

  it('復路のTYOは羽田と成田の具体的回答に一致し、別空港と逆方向を拒否する', () => {
    const haneda = returnOffer({ seats: 0 })
    const narita = returnOffer({ flightNumber: 'NH181', destinationLabel: ' 東京（成田） ', seats: 1 })
    const rows = [haneda, narita, returnOffer({ destinationLabel: '東京' }), returnOffer({ destinationLabel: '大阪（伊丹）' }), offer()]
    expect(filterOffersForQuery(rows, query, 'economy')).toEqual([haneda, narita])
    expect(filterOffersForQuery(rows, { ...query, destination: 'HND' }, 'economy')).toEqual([haneda])
    expect(filterOffersForQuery(rows, { ...query, destination: 'NRT' }, 'economy')).toEqual([narita])
  })

  it('クラス・日付境界・ANA便名・整数席数を厳密に検証する', () => {
    const first = returnOffer()
    const last = returnOffer({ date: '2026-10-06' })
    const invalid = [
      returnOffer({ date: '2026-10-03' }), returnOffer({ date: '2026-10-07' }), returnOffer({ date: '2026-10-04T00:00:00Z' }),
      returnOffer({ cabin: 'business' }), returnOffer({ flightNumber: 'UA185' }), returnOffer({ flightNumber: 'NH185X' }),
      returnOffer({ seats: -1 }), returnOffer({ seats: 1.5 }), returnOffer({ seats: Number.POSITIVE_INFINITY }),
      returnOffer({ time: '24:00' }), returnOffer({ originLabel: 'ホノルル空港' }),
    ]
    expect(filterOffersForQuery([first, ...invalid, last], query, 'economy')).toEqual([first, last])
    expect(filterOffersForQuery([first], { ...query, dateFrom: '2026-10-32' }, 'economy')).toEqual([])
    expect(filterOffersForQuery([first], { ...query, dateTo: '2026-10-03' }, 'economy')).toEqual([])
  })
})

describe('国際往復の空席ペア', () => {
  const roundtrip = (overrides: Partial<SearchFilters> = {}) => filters({
    tripType: 'roundtrip', nights: 3, passengers: 2, budget: 80_000, dateTo: '2026-10-01', ...overrides,
  })

  it('両方向の全組合せを作り、全員分の合計を再計算する', () => {
    const input = roundtrip()
    const results = searchAwards(input, today).results.map(result => ({
      ...result, options: result.options.map(option => ({ ...option, totalMiles: 1, milesPerPerson: 1 })),
    }))
    const offers = [offer(), offer({ flightNumber: 'NH188', time: '22:00' }), returnOffer(), returnOffer({ flightNumber: 'NH187', time: '14:00' })]
    const pairs = pairRoundtripOffers(offers, results, input)
    expect(pairs).toHaveLength(4)
    expect(pairs.every(pair => pair.totalMiles === 80_000)).toBe(true)
    expect(pairs.map(pair => [pair.outbound.flightNumber, pair.inbound.flightNumber])).toEqual([
      ['NH186', 'NH185'], ['NH186', 'NH187'], ['NH188', 'NH185'], ['NH188', 'NH187'],
    ])
    expect(pairRoundtripOffers([...offers, ...offers], [...results, ...results], input)).toHaveLength(4)
  })

  it('東京まとめ検索でも羽田発と成田着を混ぜず、同じ具体的空港を往復させる', () => {
    const input = roundtrip()
    const results = searchAwards(input, today).results
    const hndOut = offer()
    const nrtOut = offer({ flightNumber: 'NH184', originLabel: '東京(成田)' })
    const hndBack = returnOffer()
    const nrtBack = returnOffer({ flightNumber: 'NH183', destinationLabel: '東京(成田)' })
    expect(pairRoundtripOffers([hndOut, nrtBack], results, input)).toEqual([])
    expect(pairRoundtripOffers([nrtOut, hndBack], results, input)).toEqual([])
    const pairs = pairRoundtripOffers([hndOut, nrtOut, hndBack, nrtBack], results, input)
    expect(pairs).toHaveLength(2)
    expect(pairs.every(pair => pair.outbound.originLabel === pair.inbound.destinationLabel)).toBe(true)
    expect(pairRoundtripOffers([hndOut, nrtOut, hndBack, nrtBack], results, { ...input, origin: 'HND' })).toHaveLength(1)
  })

  it('0席と人数不足のペアも返し、表示側の切替に判断を残す', () => {
    const input = roundtrip()
    const results = searchAwards(input, today).results
    const pairs = pairRoundtripOffers([
      offer({ seats: 2 }), returnOffer({ seats: 0 }), returnOffer({ flightNumber: 'NH187', seats: 1 }),
    ], results, input)
    expect(pairs).toHaveLength(2)
    expect(pairs.map(pair => [pair.outbound.seats, pair.inbound.seats])).toEqual([[2, 0], [2, 1]])
    expect(pairs.filter(pair => pair.outbound.seats >= input.passengers && pair.inbound.seats >= input.passengers)).toEqual([])
  })

  it('片側未取得、現地復路日違い、別クラス、別出発空港をペアにしない', () => {
    const input = roundtrip()
    const results = searchAwards(input, today).results
    expect(pairRoundtripOffers([offer()], results, input)).toEqual([])
    expect(pairRoundtripOffers([returnOffer()], results, input)).toEqual([])
    const invalidBacks = [
      returnOffer({ date: '2026-10-05' }), returnOffer({ cabin: 'business' }),
      returnOffer({ originLabel: 'ロサンゼルス' }), returnOffer({ flightNumber: 'UA185' }), returnOffer({ seats: -1 }),
    ]
    expect(pairRoundtripOffers([offer(), ...invalidBacks], results, input)).toEqual([])
    const shifted = results.map(result => ({ ...result, options: result.options.map(option => ({ ...option, returnDate: '2026-10-05' })) }))
    expect(pairRoundtripOffers([offer(), returnOffer({ date: '2026-10-05' })], shifted, input)).toEqual([])
  })

  it('往復総予算と人数の境界を守り、片道条件へ往復ペアを流用しない', () => {
    const input = roundtrip()
    const results = searchAwards(input, today).results
    const offers = [offer(), returnOffer()]
    expect(pairRoundtripOffers(offers, results, input)).toHaveLength(1)
    expect(pairRoundtripOffers(offers, results, { ...input, budget: 79_999 })).toEqual([])
    expect(pairRoundtripOffers(offers, results, { ...input, passengers: 3 })).toEqual([])
    expect(pairRoundtripOffers(offers, results, { ...input, passengers: 0 })).toEqual([])
    expect(pairRoundtripOffers(offers, results, { ...input, tripType: 'oneway' })).toEqual([])
  })

  it('年跨ぎでも復路の現地出発日をそのまま照合する', () => {
    const input = roundtrip({ dateFrom: '2026-12-31', dateTo: '2026-12-31', nights: 3, budget: 200_000 })
    const results = searchAwards(input, today).results
    const out = offer({ date: '2026-12-31' })
    const back = returnOffer({ date: '2027-01-03', time: '23:55' })
    const pair = pairRoundtripOffers([out, back], results, input)[0]
    expect(pair.outbound.date).toBe('2026-12-31')
    expect(pair.inbound.date).toBe('2027-01-03')
    expect(pairRoundtripOffers([out, { ...back, date: '2027-01-04' }], results, input)).toEqual([])
  })
})
