import { AIRPORTS, ROUTES } from '../data/awards'
import { addDays, validateFilters, type SearchFilters } from './search'
import type { MemberItinerary, MemberQuery, MemberSegment } from './anaMember'

export type MemberRow = MemberItinerary & { outboundWaitlist?: boolean; inboundWaitlist?: boolean; checkedAt: string; passengers: number }
const airportMatches = (asked: string, actual: string) => asked === actual || asked === 'TYO' && ['HND', 'NRT'].includes(actual)
export function memberQueries(filters: SearchFilters, connected: MemberQuery | null): MemberQuery[] {
  if (!connected || Object.keys(validateFilters(filters)).length || filters.kind === 'domestic' || filters.tripType !== 'roundtrip' || filters.cabin !== 'economy') return []
  if (filters.origin !== 'ALL' && filters.origin !== connected.origin) return []
  const routes = ROUTES.filter(r => r.kind === 'international' && airportMatches(connected.origin, r.origin) && r.destination === connected.destination)
  if (!routes.some(r => filters.region === 'all' || r.region === filters.region)) return []
  const queries: MemberQuery[] = []
  for (let date = filters.dateFrom; date <= filters.dateTo; date = addDays(date, 1)) queries.push({ origin: connected.origin, destination: connected.destination, departureDate: date, returnDate: addDays(date, filters.nights), cabin: 'economy', passengers: filters.passengers })
  return queries
}

export function validMemberQuery(value: unknown): value is MemberQuery {
  if (!value || typeof value !== 'object') return false
  const q = value as MemberQuery
  const date = (s: unknown) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s
  return ['TYO', ...AIRPORTS.map(a => a.code)].includes(q.origin) && AIRPORTS.some(a => a.code === q.destination)
    && date(q.departureDate) && date(q.returnDate) && q.returnDate > q.departureDate && q.cabin === 'economy'
    && Number.isInteger(q.passengers) && q.passengers >= 1 && q.passengers <= 9
    && ROUTES.some(r => r.kind === 'international' && airportMatches(q.origin, r.origin) && r.destination === q.destination)
}

export function sameMemberQuery(a: unknown, b: MemberQuery): boolean {
  return validMemberQuery(a) && (['origin', 'destination', 'departureDate', 'returnDate', 'cabin', 'passengers'] as const).every(k => a[k] === b[k])
}

/** postMessageも外部入力として検証し、表示に必要な値だけを保持する。 */
export function readMemberRows(value: unknown, query: MemberQuery): MemberRow[] {
  if (!value || typeof value !== 'object') throw new Error('会員検索の応答形式を確認できません。')
  const reply = value as Record<string, unknown>
  if (reply.source !== 'ana-member' || reply.partial !== true || !sameMemberQuery(reply.query, query) || typeof reply.checkedAt !== 'string' || !Number.isFinite(Date.parse(reply.checkedAt)) || !Array.isArray(reply.itineraries) || !reply.itineraries.length || reply.itineraries.length > 500) throw new Error('会員検索の応答が照会条件と一致しません。')
  const checkedAt = reply.checkedAt
  const readLeg = (leg: unknown, inbound: boolean): MemberSegment[] => {
    if (!Array.isArray(leg) || leg.length !== 1) throw new Error('未対応の旅程が含まれています。')
    const s = leg[0] as MemberSegment
    if (!s || !/^NH\d{1,4}$/.test(s.flightNumber) || s.bookingClass !== 'X' || s.date !== (inbound ? query.returnDate : query.departureDate) || !airportMatches(inbound ? query.destination : query.origin, s.origin) || !airportMatches(inbound ? query.origin : query.destination, s.destination)) throw new Error('会員検索の便と照会区間が一致しません。')
    return [{ flightNumber: s.flightNumber, origin: s.origin, destination: s.destination, date: s.date, bookingClass: s.bookingClass }]
  }
  return reply.itineraries.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object') throw new Error('会員検索の回答が不正です。')
    const r = raw as Record<string, unknown>
    for (const k of ['outboundSeats', 'inboundSeats', 'totalMiles', 'totalCashJpy']) if (!Number.isSafeInteger(r[k]) || Number(r[k]) < 0 || Number(r[k]) > 100_000_000) throw new Error('会員検索の席数・料金を確認できません。')
    if (Number(r.totalMiles) <= 0 || Number(r.outboundSeats) > 99 || Number(r.inboundSeats) > 99) throw new Error('会員検索の席数・料金を確認できません。')
    for (const k of ['outboundWaitlist', 'inboundWaitlist']) if (r[k] !== undefined && typeof r[k] !== 'boolean') throw new Error('会員検索の空席待ち状態を確認できません。')
    return { outbound: readLeg(r.outbound, false), inbound: readLeg(r.inbound, true), outboundSeats: Number(r.outboundSeats), inboundSeats: Number(r.inboundSeats), totalMiles: Number(r.totalMiles), totalCashJpy: Number(r.totalCashJpy), ...(r.outboundWaitlist === undefined ? {} : { outboundWaitlist: r.outboundWaitlist as boolean }), ...(r.inboundWaitlist === undefined ? {} : { inboundWaitlist: r.inboundWaitlist as boolean }), checkedAt, passengers: query.passengers }
  })
}

export const memberRowKey = (r: MemberRow) => [...r.outbound, ...r.inbound].map(s => [s.flightNumber, s.origin, s.destination, s.date].join(':')).join('|')
export const memberHasSeats = (r: MemberRow) => !r.outboundWaitlist && !r.inboundWaitlist && r.outboundSeats >= r.passengers && r.inboundSeats >= r.passengers
