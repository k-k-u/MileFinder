import { AIRPORTS, type Cabin } from '../data/awards'
import type { AnaChatOffer } from './anaChat'
import { addDays, todayInTokyo, validateFilters, type DateOption, type SearchFilters, type SearchResult } from './search'

export interface AvailabilityQuery {
  origin: string
  destination: string
  dateFrom: string
  dateTo: string
}

export interface LiveOfferMatch {
  offer: AnaChatOffer
  /** 対応する日付の公開マイル表による全員分の目安。空席回答の価格ではない。 */
  totalMiles: number
}

export interface LiveRoundtripMatch {
  outbound: AnaChatOffer
  inbound: AnaChatOffer
  /** 両方向の公開マイル表を合算した全員分の目安。空席回答の価格ではない。 */
  totalMiles: number
}

function normalizeAirportLabel(label: string): string {
  return label.normalize('NFKC').replace(/\s+/g, '').trim()
}

// 都市名の部分一致はしない。複数空港に一致する名前も採用しない。
const airportCodesByLabel = new Map<string, string | null>()
for (const [label, code] of [
  ...AIRPORTS.map(airport => [airport.name, airport.code]),
  ['東京(羽田)', 'HND'],
  ['東京(成田)', 'NRT'],
  ['ホノルル(オアフ島)', 'HNL'],
]) {
  const normalized = normalizeAirportLabel(label)
  const existing = airportCodesByLabel.get(normalized)
  airportCodesByLabel.set(normalized, existing === undefined || existing === code ? code : null)
}

function searchWindow(filters: SearchFilters): { dateFrom: string; dateTo: string } | undefined {
  const today = todayInTokyo()
  if (filters.kind === 'domestic' || Object.keys(validateFilters(filters, today)).length) return undefined
  const earliest = addDays(today, 4)
  const dateFrom = filters.dateFrom < earliest ? earliest : filters.dateFrom
  return dateFrom <= filters.dateTo ? { dateFrom, dateTo: filters.dateTo } : undefined
}

function matchesRoute(result: SearchResult, filters: SearchFilters): boolean {
  if (result.route.kind !== 'international' || result.tripType !== filters.tripType || result.cabin !== filters.cabin) return false
  if (result.origin.code !== result.route.origin || result.destination.code !== result.route.destination) return false
  if (filters.region !== 'all' && result.route.region !== filters.region) return false
  return filters.origin === 'ALL' || result.origin.code === filters.origin ||
    (filters.origin === 'TYO' && ['HND', 'NRT'].includes(result.origin.code))
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function milesForOption(option: DateOption, filters: SearchFilters): number | undefined {
  if (!validDate(option.departureDate) || !Number.isSafeInteger(option.outboundMiles) || option.outboundMiles <= 0) return undefined
  if (filters.tripType === 'oneway') {
    if (option.returnDate || option.inboundMiles !== 0) return undefined
  } else if (!validDate(option.returnDate) || option.returnDate !== addDays(option.departureDate, filters.nights)
    || !Number.isSafeInteger(option.inboundMiles) || option.inboundMiles <= 0) return undefined
  // 保存時の人数や合計値に依存せず、現在の人数で両方向を再計算する。
  const total = (option.outboundMiles + option.inboundMiles) * filters.passengers
  return Number.isSafeInteger(total) && total > 0 && total <= filters.budget ? total : undefined
}

function milesForDate(result: SearchResult, date: string, filters: SearchFilters): number | undefined {
  const option = result.options.find(option => option.departureDate === date)
  return option ? milesForOption(option, filters) : undefined
}

/** 予算内の国際線候補を最大7日間の照会へまとめる。往復は逆方向も独立に照会する。 */
export function buildAvailabilityQueries(
  results: SearchResult[],
  filters: SearchFilters,
  destination = 'all',
): AvailabilityQuery[] {
  const range = searchWindow(filters)
  if (!range) return []
  const routes = new Map<string, {
    origin: string; destination: string; dates: Set<string>; dateFrom: string; dateTo: string
  }>()
  function addDate(origin: string, destinationCode: string, date: string, returnLeg: boolean) {
    const key = `${origin}:${destinationCode}`
    let route = routes.get(key)
    if (!route) {
      const offset = returnLeg ? filters.nights : 0
      route = {
        origin, destination: destinationCode, dates: new Set(),
        dateFrom: addDays(range!.dateFrom, offset), dateTo: addDays(range!.dateTo, offset),
      }
      routes.set(key, route)
    }
    route.dates.add(date)
  }
  for (const result of results) {
    if (!matchesRoute(result, filters) || (destination !== 'all' && result.destination.code !== destination)) continue
    const origin = filters.origin === 'TYO' ? 'TYO' : result.origin.code
    for (const option of result.options) {
      if (option.departureDate < range.dateFrom || option.departureDate > range.dateTo || milesForOption(option, filters) === undefined) continue
      addDate(origin, result.destination.code, option.departureDate, false)
      // 復路の日付は海外出発地の現地日付。日本の到着日へ変換しない。
      if (filters.tripType === 'roundtrip' && option.returnDate) addDate(result.destination.code, origin, option.returnDate, true)
    }
  }

  const queries: AvailabilityQuery[] = []
  for (const route of routes.values()) {
    for (let dateFrom = route.dateFrom; dateFrom <= route.dateTo; dateFrom = addDays(dateFrom, 7)) {
      const seventhDay = addDays(dateFrom, 6)
      const dateTo = seventhDay < route.dateTo ? seventhDay : route.dateTo
      if (![...route.dates].some(date => dateFrom <= date && date <= dateTo)) continue
      queries.push({ origin: route.origin, destination: route.destination, dateFrom, dateTo })
    }
  }
  return queries
}

function offerAirportCodes(offer: AnaChatOffer): { origin: string; destination: string } | undefined {
  if (!offer || typeof offer !== 'object' || !/^NH\d{1,4}$/.test(offer.flightNumber)
    || typeof offer.originLabel !== 'string' || typeof offer.destinationLabel !== 'string'
    || !validDate(offer.date) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(offer.time)
    || !Number.isSafeInteger(offer.seats) || offer.seats < 0
    || offer.source !== 'ana-public-chat' || offer.accountScope !== 'anonymous') return undefined
  const origin = airportCodesByLabel.get(normalizeAirportLabel(offer.originLabel))
  const destination = airportCodesByLabel.get(normalizeAirportLabel(offer.destinationLabel))
  return origin && destination && origin !== destination ? { origin, destination } : undefined
}

function airportMatches(code: string, requested: string): boolean {
  return code === requested || (requested === 'TYO' && ['HND', 'NRT'].includes(code))
}

/** 単独の照会条件へ厳密に対応させる。往路・復路の両方向を扱い、0席も保持する。 */
export function filterOffersForQuery(offers: AnaChatOffer[], query: AvailabilityQuery, cabin: Cabin): AnaChatOffer[] {
  if (!validDate(query.dateFrom) || !validDate(query.dateTo) || query.dateTo < query.dateFrom || query.origin === query.destination) return []
  return offers.filter(offer => {
    const airports = offerAirportCodes(offer)
    return !!airports && offer.cabin === cabin && offer.date >= query.dateFrom && offer.date <= query.dateTo
      && airportMatches(airports.origin, query.origin) && airportMatches(airports.destination, query.destination)
  })
}

/** 回答の空港区間・日付・クラスを候補に厳密対応させる。0席や人数不足は表示側で区別する。 */
export function filterLiveOffers(
  offers: AnaChatOffer[],
  results: SearchResult[],
  filters: SearchFilters,
): LiveOfferMatch[] {
  if (filters.tripType !== 'oneway') return []
  const range = searchWindow(filters)
  if (!range) return []
  const applicable = results.filter(result => matchesRoute(result, filters))
  return offers.flatMap(offer => {
    const airports = offerAirportCodes(offer)
    if (!airports || offer.cabin !== filters.cabin || offer.date < range.dateFrom || offer.date > range.dateTo) return []
    const result = applicable.find(result => result.origin.code === airports.origin && result.destination.code === airports.destination)
    if (!result) return []
    const totalMiles = milesForDate(result, offer.date, filters)
    return totalMiles === undefined ? [] : [{ offer, totalMiles }]
  })
}

/**
 * 同一の具体的空港を往復する便の全組合せを返す。席数不足・0席のペアも保持する。
 * 片側が未取得ならペアは生成せず、ペアなしを空席なしの根拠にはしない。
 */
export function pairRoundtripOffers(
  offers: AnaChatOffer[],
  results: SearchResult[],
  filters: SearchFilters,
): LiveRoundtripMatch[] {
  if (filters.tripType !== 'roundtrip') return []
  const range = searchWindow(filters)
  if (!range) return []
  const index = new Map<string, AnaChatOffer[]>()
  const legKey = (origin: string, destination: string, date: string) => `${origin}|${destination}|${date}`
  for (const offer of offers) {
    const airports = offerAirportCodes(offer)
    if (!airports || offer.cabin !== filters.cabin) continue
    const key = legKey(airports.origin, airports.destination, offer.date)
    const matches = index.get(key) ?? []
    matches.push(offer)
    index.set(key, matches)
  }
  const pairs = new Map<string, LiveRoundtripMatch>()
  for (const result of results) {
    if (!matchesRoute(result, filters)) continue
    for (const option of result.options) {
      if (option.departureDate < range.dateFrom || option.departureDate > range.dateTo || !option.returnDate) continue
      const totalMiles = milesForOption(option, filters)
      if (totalMiles === undefined) continue
      const outbound = index.get(legKey(result.origin.code, result.destination.code, option.departureDate)) ?? []
      const inbound = index.get(legKey(result.destination.code, result.origin.code, option.returnDate)) ?? []
      for (const out of outbound) {
        for (const back of inbound) {
          const key = [result.origin.code, result.destination.code, out.date, out.flightNumber, out.time,
            back.date, back.flightNumber, back.time, filters.cabin].join('|')
          pairs.set(key, { outbound: out, inbound: back, totalMiles })
        }
      }
    }
  }
  return [...pairs.values()]
}
