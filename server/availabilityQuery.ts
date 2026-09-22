import { ROUTES } from '../src/data/awards'
import { addDays, todayInTokyo } from '../src/lib/search'
import type { AnaAvailabilityQuery } from './anaProvider'

/** ローカル・公開APIで同じ区間と期間の制約を使用する。 */
export function validQuery(value: unknown): value is AnaAvailabilityQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const q = value as Record<string, unknown>
  if (Object.keys(q).length !== 4 || Object.keys(q).some(k => !['origin', 'destination', 'dateFrom', 'dateTo'].includes(k))) return false
  if (![q.origin, q.destination, q.dateFrom, q.dateTo].every(v => typeof v === 'string')) return false
  const matchesAirport = (requested: unknown, airport: string) => requested === airport || requested === 'TYO' && ['HND', 'NRT'].includes(airport)
  const known = ROUTES.some(r => r.kind === 'international' && (
    matchesAirport(q.origin, r.origin) && matchesAirport(q.destination, r.destination)
    || matchesAirport(q.origin, r.destination) && matchesAirport(q.destination, r.origin)
  ))
  const dates = [q.dateFrom, q.dateTo] as string[]
  if (!known || dates.some(d => !/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(Date.parse(d)) || new Date(d).toISOString().slice(0, 10) !== d)) return false
  const today = todayInTokyo()
  return dates[0] >= addDays(today, 4) && dates[1] >= dates[0] && dates[1] <= addDays(dates[0], 6) && dates[1] <= addDays(today, 355)
}
