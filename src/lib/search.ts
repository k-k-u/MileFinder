import {
  AIRPORTS,
  PRICING,
  ROUTES,
  SEASON_CALENDARS,
  type Airport,
  type AwardRoute,
  type Cabin,
  type Season,
} from '../data/awards'

export interface SearchFilters {
  kind: 'all' | 'domestic' | 'international'
  origin: string
  region: string
  dateFrom: string
  dateTo: string
  tripType: 'oneway' | 'roundtrip'
  nights: number
  cabin: Cabin
  passengers: number
  /** 全員・全旅程の合計マイル上限。 */
  budget: number
}

export interface DateOption {
  departureDate: string
  returnDate?: string
  departureSeason: Season
  returnSeason?: Season
  outboundMiles: number
  inboundMiles: number
  milesPerPerson: number
  totalMiles: number
}

export interface SearchResult {
  id: string
  route: AwardRoute
  origin: Airport
  destination: Airport
  cabin: Cabin
  passengers: number
  tripType: SearchFilters['tripType']
  options: DateOption[]
  minMiles: number
  maxMiles: number
  cheapest: DateOption
}

export type ValidationErrors = Partial<Record<keyof SearchFilters, string>>

export interface SearchResponse {
  results: SearchResult[]
  warnings: string[]
  errors: ValidationErrors
  totalOptions: number
  excludedUnpublished: number
}

export type ResultSort = 'miles' | 'destination' | 'dates'

const DAY_MS = 86_400_000
const BOOKING_HORIZON_DAYS = 355
const MAX_SEARCH_DAYS = 62
const airportByCode = new Map(AIRPORTS.map((airport) => [airport.code, airport]))
const cabins: Cabin[] = ['economy', 'premium', 'business', 'first']

/** 日付は時刻や実行環境のタイムゾーンに左右されない日単位で扱う。 */
function parseDate(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const timestamp = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(timestamp)) return undefined
  if (new Date(timestamp).toISOString().slice(0, 10) !== value) return undefined
  return timestamp / DAY_MS
}

function formatDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10)
}

export function todayInTokyo(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const value = (type: string) => parts.find((part) => part.type === type)?.value
  return `${value('year')}-${value('month')}-${value('day')}`
}

export function addDays(isoDate: string, days: number): string {
  const day = parseDate(isoDate)
  if (day === undefined || !Number.isInteger(days)) {
    throw new RangeError('実在する日付と整数の日数を指定してください。')
  }
  return formatDay(day + days)
}

export function defaults(today = todayInTokyo()): SearchFilters {
  return {
    kind: 'all',
    origin: 'TYO',
    region: 'all',
    dateFrom: addDays(today, 30),
    dateTo: addDays(today, 59),
    tripType: 'roundtrip',
    nights: 3,
    cabin: 'economy',
    passengers: 1,
    budget: 60_000,
  }
}

export function validateFilters(
  filters: SearchFilters,
  today = todayInTokyo(),
): ValidationErrors {
  const errors: ValidationErrors = {}
  const todayDay = parseDate(today)
  if (todayDay === undefined) throw new RangeError('基準日が不正です。')
  const firstDay = parseDate(filters.dateFrom)
  const lastDay = parseDate(filters.dateTo)
  const lastBookableDay = todayDay + BOOKING_HORIZON_DAYS

  if (!['all', 'domestic', 'international'].includes(filters.kind)) {
    errors.kind = '国内線・国際線を選択してください。'
  }
  if (!['ALL', 'TYO'].includes(filters.origin) && !airportByCode.has(filters.origin)) {
    errors.origin = '出発空港を選択してください。'
  }
  if (filters.region !== 'all' && !ROUTES.some((route) => route.region === filters.region)) {
    errors.region = '目的地のエリアを選択してください。'
  }
  if (!['oneway', 'roundtrip'].includes(filters.tripType)) {
    errors.tripType = '片道または往復を選択してください。'
  }
  if (!cabins.includes(filters.cabin)) errors.cabin = '座席クラスを選択してください。'
  if (!Number.isInteger(filters.passengers) || filters.passengers < 1 || filters.passengers > 9) {
    errors.passengers = '人数は1〜9名の整数で指定してください。'
  }
  if (!Number.isSafeInteger(filters.budget) || filters.budget < 1) {
    errors.budget = '保有マイルは1以上の整数で入力してください。'
  }
  if (!Number.isInteger(filters.nights) || filters.nights < 1 || filters.nights > 30) {
    errors.nights = '滞在日数は1〜30泊の整数で指定してください。'
  }

  if (firstDay === undefined) errors.dateFrom = '出発期間の開始日を正しく入力してください。'
  else if (firstDay < todayDay) errors.dateFrom = '開始日は本日以降を指定してください。'
  else if (firstDay > lastBookableDay) errors.dateFrom = '開始日は本日から355日以内を指定してください。'

  if (lastDay === undefined) errors.dateTo = '出発期間の終了日を正しく入力してください。'
  else if (lastDay < todayDay) errors.dateTo = '終了日は本日以降を指定してください。'
  else if (lastDay > lastBookableDay) errors.dateTo = '終了日は本日から355日以内を指定してください。'

  if (firstDay !== undefined && lastDay !== undefined) {
    if (lastDay < firstDay) errors.dateTo = '終了日は開始日以降を指定してください。'
    else if (lastDay - firstDay + 1 > MAX_SEARCH_DAYS) {
      errors.dateTo = '出発期間は開始日と終了日を含め62日以内にしてください。'
    }
    if (filters.tripType === 'roundtrip' && !errors.nights && lastDay + filters.nights > lastBookableDay) {
      errors.nights = '復路も本日から355日以内になるよう、出発期間または滞在日数を変更してください。'
    }
  }
  return errors
}

function seasonOn(date: string, group: AwardRoute['seasonGroup']): Season | undefined {
  return SEASON_CALENDARS[group].find((range) => range.start <= date && date <= range.end)?.season
}

function matchesOrigin(route: AwardRoute, origin: string): boolean {
  return origin === 'ALL' || route.origin === origin ||
    (origin === 'TYO' && ['HND', 'NRT'].includes(route.origin))
}

export function searchAwards(filters: SearchFilters, today = todayInTokyo()): SearchResponse {
  const errors = validateFilters(filters, today)
  const response: SearchResponse = {
    results: [],
    warnings: [],
    errors,
    totalOptions: 0,
    excludedUnpublished: 0,
  }
  if (Object.keys(errors).length > 0) return response

  const firstDay = parseDate(filters.dateFrom)!
  const lastDay = parseDate(filters.dateTo)!
  for (const route of ROUTES) {
    if (route.origin === route.destination || !matchesOrigin(route, filters.origin)) continue
    if (filters.kind !== 'all' && route.kind !== filters.kind) continue
    if (filters.region !== 'all' && route.region !== filters.region) continue
    const origin = airportByCode.get(route.origin)
    const destination = airportByCode.get(route.destination)
    const milesBySeason = PRICING[route.pricingKey]?.[filters.cabin]
    if (!origin || !destination || !milesBySeason) continue

    const options: DateOption[] = []
    for (let day = firstDay; day <= lastDay; day += 1) {
      const departureDate = formatDay(day)
      const returnDate = filters.tripType === 'roundtrip' ? formatDay(day + filters.nights) : undefined
      const departureSeason = seasonOn(departureDate, route.seasonGroup)
      const returnSeason = returnDate ? seasonOn(returnDate, route.seasonGroup) : undefined
      if (!departureSeason || (returnDate && !returnSeason)) {
        response.excludedUnpublished += 1
        continue
      }
      const outboundMiles = milesBySeason[departureSeason]
      const inboundMiles = returnSeason ? milesBySeason[returnSeason] : 0
      const milesPerPerson = outboundMiles + inboundMiles
      const totalMiles = milesPerPerson * filters.passengers
      if (!Number.isFinite(totalMiles) || totalMiles <= 0 || totalMiles > filters.budget) continue
      options.push({
        departureDate,
        returnDate,
        departureSeason,
        returnSeason,
        outboundMiles,
        inboundMiles,
        milesPerPerson,
        totalMiles,
      })
    }
    if (options.length === 0) continue
    const cheapest = options.reduce((best, option) => option.totalMiles < best.totalMiles ? option : best)
    response.results.push({
      id: route.id,
      route,
      origin,
      destination,
      cabin: filters.cabin,
      passengers: filters.passengers,
      tripType: filters.tripType,
      options,
      minMiles: cheapest.totalMiles,
      maxMiles: Math.max(...options.map((option) => option.totalMiles)),
      cheapest,
    })
    response.totalOptions += options.length
  }
  if (response.excludedUnpublished > 0) {
    response.warnings.push(
      `シーズンの公表範囲外の日を含む${response.excludedUnpublished.toLocaleString('ja-JP')}件の旅程は、必要マイルを算出せず除外しました。`,
    )
  }
  response.results = sortResults(response.results, 'miles')
  return response
}

export function sortResults(results: SearchResult[], sort: ResultSort): SearchResult[] {
  return [...results].sort((a, b) => {
    let difference = 0
    if (sort === 'destination') difference = a.destination.city.localeCompare(b.destination.city, 'ja')
    if (sort === 'dates') difference = b.options.length - a.options.length
    return difference || a.minMiles - b.minMiles || a.destination.city.localeCompare(b.destination.city, 'ja') ||
      a.origin.code.localeCompare(b.origin.code)
  })
}

const cabinLabels: Record<Cabin, string> = {
  economy: 'エコノミー',
  premium: 'プレミアムエコノミー',
  business: 'ビジネス',
  first: 'ファースト',
}

/** テキストの先頭が数式として解釈される文字なら無害化してから引用する。 */
function csvCell(value: string | number): string {
  let text = String(value)
  if (typeof value === 'string' && /^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = `'${text}`
  return `"${text.replace(/"/g, '""')}"`
}

/** UTF-8 BOMを付け、日本語を含むCSVをExcelでも開けるようにする。 */
export function exportCsv(results: SearchResult[]): string {
  const rows: Array<Array<string | number>> = [[
    '出発空港', '出発空港コード', '到着空港', '到着空港コード', '路線種別',
    '旅程', 'クラス', '人数', '出発日', '復路日', '往路シーズン', '復路シーズン',
    '往路マイル（1名）', '復路マイル（1名）', '合計マイル（1名）', '合計マイル（全員）', '空席確認',
  ]]
  for (const result of results) {
    for (const option of result.options) {
      rows.push([
        result.origin.name,
        result.origin.code,
        result.destination.name,
        result.destination.code,
        result.route.kind === 'domestic' ? '国内線' : '国際線',
        result.tripType === 'roundtrip' ? '往復' : '片道',
        cabinLabels[result.cabin],
        result.passengers,
        option.departureDate,
        option.returnDate ?? '',
        option.departureSeason,
        option.returnSeason ?? '',
        option.outboundMiles,
        option.inboundMiles,
        option.milesPerPerson,
        option.totalMiles,
        '未照会（必要マイルの目安）',
      ])
    }
  }
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`
}
