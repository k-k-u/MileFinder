import { describe, expect, it, vi } from 'vitest'
import { addDays, defaults, exportCsv, searchAwards, sortResults, validateFilters, type SearchFilters } from './search'

vi.mock('../data/awards', () => {
  const ranges = [
    { start: '2026-10-01', end: '2026-10-14', season: 'L' },
    { start: '2026-10-15', end: '2026-10-29', season: 'R' },
    { start: '2026-10-30', end: '2026-11-05', season: 'H' },
  ]
  return {
    AIRPORTS: [
      { code: 'HND', name: '東京（羽田）', city: '東京', country: '日本', region: '国内' },
      { code: 'NRT', name: '東京（成田）', city: '東京', country: '日本', region: '国内' },
      { code: 'CTS', name: '札幌（新千歳）', city: '札幌', country: '日本', region: '国内' },
      { code: 'ICN', name: 'ソウル（仁川）', city: 'ソウル', country: '韓国', region: 'アジア' },
    ],
    ROUTES: [
      { id: 'HND-CTS', origin: 'HND', destination: 'CTS', kind: 'domestic', region: '国内', pricingKey: 'domestic', seasonGroup: 'domestic', sourceIds: [] },
      { id: 'CTS-HND', origin: 'CTS', destination: 'HND', kind: 'domestic', region: '国内', pricingKey: 'domestic', seasonGroup: 'domestic', sourceIds: [] },
      { id: 'NRT-ICN', origin: 'NRT', destination: 'ICN', kind: 'international', region: 'アジア', pricingKey: 'international', seasonGroup: 'asia', sourceIds: [] },
      { id: 'HND-ICN', origin: 'HND', destination: 'ICN', kind: 'international', region: 'アジア', pricingKey: 'international', seasonGroup: 'asia', sourceIds: [] },
      { id: 'HND-HND', origin: 'HND', destination: 'HND', kind: 'domestic', region: '国内', pricingKey: 'domestic', seasonGroup: 'domestic', sourceIds: [] },
    ],
    PRICING: {
      domestic: { economy: { L: 6000, R: 7500, H: 10500 } },
      international: {
        economy: { L: 6000, R: 7500, H: 15000 },
        business: { L: 15000, R: 20000, H: 30000 },
      },
    },
    SEASON_CALENDARS: { domestic: ranges, asia: ranges, western: ranges, pacific: [] },
  }
})

const today = '2026-09-22'
function filters(overrides: Partial<SearchFilters> = {}): SearchFilters {
  return {
    ...defaults(today),
    kind: 'domestic',
    origin: 'HND',
    dateFrom: '2026-10-14',
    dateTo: '2026-10-14',
    nights: 1,
    passengers: 2,
    budget: 30_000,
    ...overrides,
  }
}

describe('日付と入力の検証', () => {
  it('月末・年末・うるう日の日付計算をUTCの日単位で行う', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2028-02-29', 1)).toBe('2028-03-01')
    expect(() => addDays('2026-02-29', 1)).toThrow(RangeError)
  })

  it.each(['2026-02-29', '2026-09-31', '2026-13-01', '2026-00-10', '2026-1-01', '', 'bad'])('実在しない日付 %s を拒否する', (dateFrom) => {
    expect(validateFilters(filters({ dateFrom }), today).dateFrom).toBeDefined()
  })

  it('本日・355日先を許可し、過去・356日先を拒否する', () => {
    const end = addDays(today, 355)
    expect(validateFilters(filters({ dateFrom: today, dateTo: today, tripType: 'oneway' }), today)).toEqual({})
    expect(validateFilters(filters({ dateFrom: end, dateTo: end, tripType: 'oneway' }), today)).toEqual({})
    expect(validateFilters(filters({ dateFrom: addDays(today, -1) }), today).dateFrom).toBeDefined()
    expect(validateFilters(filters({ dateTo: addDays(today, 356) }), today).dateTo).toBeDefined()
  })

  it('両端含む62日まで許可し、逆転した期間と63日間を拒否する', () => {
    expect(validateFilters(filters({ dateFrom: today, dateTo: addDays(today, 61) }), today)).toEqual({})
    expect(validateFilters(filters({ dateFrom: today, dateTo: addDays(today, 62) }), today).dateTo).toBeDefined()
    expect(validateFilters(filters({ dateTo: '2026-10-13' }), today).dateTo).toBeDefined()
  })

  it('復路を含め355日以内とし、片道には復路の制約を適用しない', () => {
    const date = addDays(today, 353)
    expect(validateFilters(filters({ dateFrom: date, dateTo: date, nights: 2 }), today)).toEqual({})
    expect(validateFilters(filters({ dateFrom: date, dateTo: date, nights: 3 }), today).nights).toBeDefined()
    expect(validateFilters(filters({ dateFrom: date, dateTo: date, nights: 3, tripType: 'oneway' }), today)).toEqual({})
  })

  it.each([
    ['passengers', 0], ['passengers', 10], ['passengers', 1.5], ['passengers', Number.NaN],
    ['budget', 0], ['budget', -1], ['budget', Number.POSITIVE_INFINITY], ['budget', Number.MAX_SAFE_INTEGER + 1],
    ['nights', 0], ['nights', 31], ['nights', 2.5],
    ['origin', 'XYZ'], ['region', 'unknown'], ['kind', 'invalid'], ['cabin', 'invalid'], ['tripType', 'invalid'],
  ])('不正な%s=%sを拒否し検索を実行しない', (key, value) => {
    const input = filters({ [key]: value } as Partial<SearchFilters>)
    const result = searchAwards(input, today)
    expect(result.errors[key as keyof SearchFilters]).toBeDefined()
    expect(result.results).toEqual([])
    expect(result.totalOptions).toBe(0)
  })
})

describe('必要マイル検索', () => {
  it('往路と復路のシーズンを別々に適用し、2名往復の総マイルを計算する', () => {
    const response = searchAwards(filters(), today)
    expect(response.errors).toEqual({})
    expect(response.results).toHaveLength(1)
    expect(response.results[0].cheapest).toEqual({
      departureDate: '2026-10-14', returnDate: '2026-10-15',
      departureSeason: 'L', returnSeason: 'R',
      outboundMiles: 6000, inboundMiles: 7500, milesPerPerson: 13500, totalMiles: 27000,
    })
  })

  it('全員分の総マイルが予算と同額なら含め、1マイルでも超えれば除外する', () => {
    expect(searchAwards(filters({ budget: 27_000 }), today).results).toHaveLength(1)
    expect(searchAwards(filters({ budget: 26_999 }), today).results).toHaveLength(0)
  })

  it('期間の両端を列挙し、路線ごとの最小・最大と最安日を集約する', () => {
    const response = searchAwards(filters({ dateFrom: '2026-10-13', dateTo: '2026-10-16' }), today)
    const result = response.results[0]
    expect(response.totalOptions).toBe(4)
    expect(result.options.map((option) => option.departureDate)).toEqual(['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'])
    expect(result.minMiles).toBe(24_000)
    expect(result.maxMiles).toBe(30_000)
    expect(result.cheapest.departureDate).toBe('2026-10-13')
  })

  it('東京すべては羽田・成田の両方を含み、国内外とエリア条件を適用する', () => {
    const input = filters({ kind: 'all', origin: 'TYO', tripType: 'oneway', passengers: 1 })
    expect(searchAwards(input, today).results.map((result) => result.id).sort()).toEqual(['HND-CTS', 'HND-ICN', 'NRT-ICN'])
    expect(searchAwards({ ...input, region: 'アジア' }, today).results).toHaveLength(2)
    expect(searchAwards({ ...input, kind: 'international' }, today).results).toHaveLength(2)
    expect(searchAwards({ ...input, origin: 'NRT' }, today).results.map((result) => result.id)).toEqual(['NRT-ICN'])
  })

  it('全空港の検索でも同一空港発着を除外し、逆方向の登録路線を含める', () => {
    const response = searchAwards(filters({ origin: 'ALL', tripType: 'oneway' }), today)
    expect(response.results.map((result) => result.id).sort()).toEqual(['CTS-HND', 'HND-CTS'])
    expect(response.results.every((result) => result.origin.code !== result.destination.code)).toBe(true)
  })

  it('設定のない座席クラスのマイルを推測しない', () => {
    expect(searchAwards(filters({ cabin: 'business' }), today).results).toEqual([])
    expect(searchAwards(filters({ kind: 'international', cabin: 'business', tripType: 'oneway', passengers: 1 }), today).results[0].minMiles).toBe(15_000)
  })

  it('片道では復路を生成せず、片道分だけ人数倍する', () => {
    const result = searchAwards(filters({ tripType: 'oneway' }), today).results[0]
    expect(result.cheapest.returnDate).toBeUndefined()
    expect(result.cheapest.returnSeason).toBeUndefined()
    expect(result.cheapest.inboundMiles).toBe(0)
    expect(result.minMiles).toBe(12_000)
  })

  it('未公表の復路を含む旅程だけ除外し、件数と警告を返す', () => {
    const response = searchAwards(filters({ dateFrom: '2026-11-04', dateTo: '2026-11-06', passengers: 1, budget: 100_000 }), today)
    expect(response.results[0].options.map((option) => option.departureDate)).toEqual(['2026-11-04'])
    expect(response.excludedUnpublished).toBe(2)
    expect(response.warnings[0]).toContain('2件')
  })

  it('未公表の往路を季節の近似値で埋めない', () => {
    const response = searchAwards(filters({ dateFrom: '2026-09-30', dateTo: '2026-10-01', tripType: 'oneway' }), today)
    expect(response.results[0].options.map((option) => option.departureDate)).toEqual(['2026-10-01'])
    expect(response.excludedUnpublished).toBe(1)
  })
})

describe('結果の表示・書き出し', () => {
  it('並べ替えで元の配列を変更しない', () => {
    const results = searchAwards(filters({ origin: 'TYO', kind: 'all', tripType: 'oneway' }), today).results
    const original = [...results]
    const sorted = sortResults(results, 'destination')
    expect(sorted).not.toBe(results)
    expect(results).toEqual(original)
    expect(sorted[0].destination.city).toBe('ソウル')
  })

  it('全候補を日本語・UTF-8 BOM・CRLFでCSV出力し、条件と空席未照会を残す', () => {
    const results = searchAwards(filters({ dateFrom: '2026-10-13', dateTo: '2026-10-14' }), today).results
    const csv = exportCsv(results)
    expect(csv.startsWith('\uFEFF')).toBe(true)
    expect(csv.split('\r\n')).toHaveLength(4)
    expect(csv).toContain('"往復","エコノミー","2"')
    expect(csv).toContain('"2026-10-14","2026-10-15","L","R","6000","7500","13500","27000"')
    expect(csv).toContain('未照会')
  })

  it('CSVの数式開始文字と引用符をエスケープする', () => {
    const results = searchAwards(filters(), today).results
    const result = { ...results[0], origin: { ...results[0].origin, name: ' \t=HYPERLINK("https://example.com")' } }
    const csv = exportCsv([result])
    expect(csv).toContain('"\' \t=HYPERLINK(""https://example.com"")"')
  })
})
