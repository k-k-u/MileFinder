import type { Cabin } from '../data/awards'

export interface AnaChatOffer {
  flightNumber: string
  originLabel: string
  destinationLabel: string
  date: string
  time: string
  cabin: Cabin
  /** 回答に明示された席数。0席も保持し、未取得とは区別する。 */
  seats: number
  /** 観測済みの「0席(空席待ち可能)」の回答だけに付与する。空席ありとは扱わない。 */
  waitlistAvailable?: true
  source: 'ana-public-chat'
  accountScope: 'anonymous'
}

export interface AnaChatDateRange {
  dateFrom: string
  dateTo: string
}

export interface AnaChatPage {
  offers: AnaChatOffer[]
  hasMore: boolean
  /**
   * 対象期間内の既知の直行便書式を1行以上解釈できたか。
   * 検索の網羅性や予約可能性を意味せず、falseを空席なしとして扱わない。
   */
  recognized: boolean
}

const CABIN_LABELS = new Map<string, Cabin>([
  ['エコノミークラス', 'economy'],
  ['プレミアムエコノミー', 'premium'],
  ['ビジネスクラス', 'business'],
  ['ファーストクラス', 'first'],
])

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function resolveDate(month: string, day: string, range: AnaChatDateRange): string | undefined {
  let match: string | undefined
  const firstYear = Number(range.dateFrom.slice(0, 4))
  const lastYear = Number(range.dateTo.slice(0, 4))
  for (let year = firstYear; year <= lastYear; year += 1) {
    const date = `${String(year).padStart(4, '0')}-${month}-${day}`
    if (date < range.dateFrom || date > range.dateTo || !isIsoDate(date)) continue
    // 回答には年がないため、複数年に該当する日付は推測しない。
    if (match !== undefined) return undefined
    match = date
  }
  return match
}

function parseDirectFlight(body: string, range: AnaChatDateRange): AnaChatOffer[] {
  const lines = body.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const flight = /^([A-Z0-9]{2}\d{1,4})便(?:\s+(.+))?$/.exec(lines[0] ?? '')
  if (!flight) return []
  // 観測した「便名と区間が別行」「同一行」の両方を扱う。
  const routeLine = flight[2] ?? lines[1]
  const route = /^(.+?)\s+-\s+(.+)$/.exec(routeLine ?? '')
  if (!route) return []
  const offers: AnaChatOffer[] = []
  let cursor = flight[2] ? 1 : 2

  while (cursor < lines.length) {
    const line = lines[cursor]
    if (/^[-#]{3,}$/.test(line)) break
    const cabin = CABIN_LABELS.get(line)
    if (!cabin) return []
    cursor += 1
    let rowCount = 0
    while (cursor < lines.length) {
      const row = /^(\d{2})\/(\d{2})\s+((?:[01]\d|2[0-3]):[0-5]\d)発(?:\s+(\d+)席(\(空席待ち可能\))?)?$/.exec(lines[cursor])
      if (!row) break
      // 復路で観測した「日時行の次に席数だけの行」も許容する。
      // 次のクラス・便・日時へ探しに行かず、直後の非空行だけを対応させる。
      const nextLineSeats = row[4] === undefined ? /^(\d+)席(\(空席待ち可能\))?$/.exec(lines[cursor + 1] ?? '') : undefined
      if (row[4] === undefined && !nextLineSeats) return []
      const seats = Number(row[4] ?? nextLineSeats![1])
      if (!Number.isSafeInteger(seats)) return []
      const waitlistAvailable = Boolean(row[5] ?? nextLineSeats?.[2])
      if (waitlistAvailable && seats !== 0) return []
      const date = resolveDate(row[1], row[2], range)
      if (date) {
        offers.push({
          flightNumber: flight[1],
          originLabel: route[1].trim(),
          destinationLabel: route[2].trim(),
          date,
          time: row[3],
          cabin,
          seats,
          ...(waitlistAvailable ? { waitlistAvailable: true as const } : {}),
          source: 'ana-public-chat',
          accountScope: 'anonymous',
        })
      }
      rowCount += 1
      cursor += nextLineSeats ? 2 : 1
    }
    // クラス名だけ、未知の席数表現、壊れた日時を含む便は採用しない。
    if (rowCount === 0) return []
  }
  return offers
}

/** 観測済みのANA公開チャット直行便回答だけを解釈する。通信・認証処理は行わない。 */
export function parseAnaChatPage(text: string, range: AnaChatDateRange): AnaChatPage {
  const result: AnaChatPage = { offers: [], hasMore: false, recognized: false }
  if (typeof text !== 'string') return result
  result.hasMore = text.includes('検索結果をさらに表示')
  if (!isIsoDate(range.dateFrom) || !isIsoDate(range.dateTo) || range.dateTo < range.dateFrom) return result

  const sections = [...text.matchAll(/^\s*\d+\)\s*([^\r\n]+)\r?$/gm)]
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index]
    if (section[1].trim() !== '直行便') continue
    const start = section.index + section[0].length
    const end = sections[index + 1]?.index ?? text.length
    result.offers.push(...parseDirectFlight(text.slice(start, end), range))
  }
  result.recognized = result.offers.length > 0
  return result
}
