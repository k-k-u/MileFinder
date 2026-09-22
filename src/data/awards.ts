/** ANA公表の事実データ。詳細な採録範囲と更新手順は docs/DATA_SOURCES.md。 */
export type Season = 'L' | 'R' | 'H'
export type Cabin = 'economy' | 'premium' | 'business' | 'first'
export type SeasonGroup = 'domestic' | 'asia' | 'western' | 'pacific'
export type AwardKind = 'domestic' | 'international'
export interface Airport {
  code: string
  name: string
  city: string
  country: string
  region: string
}
export interface AwardRoute {
  id: string
  origin: string
  destination: string
  kind: AwardKind
  region: string
  pricingKey: string
  seasonGroup: SeasonGroup
  sourceIds: string[]
}
export interface SeasonRange { start: string; end: string; season: Season }
export interface DataSource { id: string; title: string; url: string }

export const DATA_UPDATED_AT = '2026-09-22'
export const SOURCES: DataSource[] = [
  { id: 'domestic-chart', title: 'ANA 国内線特典航空券 シーズン・必要マイルチャート', url: 'https://www.ana.co.jp/ja/jp/guide/amc/award/domestic/terms/' },
  { id: 'international-chart', title: 'ANA 国際線特典航空券 シーズン・必要マイルチャート', url: 'https://www.ana.co.jp/ja/jp/guide/amc/award/international/terms/' },
  { id: 'international-routes', title: 'ANA 国際線の運航路線（2026年8月20日発表）', url: 'https://www.ana.co.jp/ja/kh/plan-book/routes/international-route-information/' },
  { id: 'domestic-tokyo', title: 'ANA 国内線時刻表 東京（2026年冬ダイヤ）', url: 'https://www.ana.co.jp/guide/plan/airinfo/dom-timetable/pdf/timetable_tokyo_20261025_20270131.pdf' },
  { id: 'domestic-osaka', title: 'ANA 国内線時刻表 大阪（2026年冬ダイヤ）', url: 'https://www.ana.co.jp/guide/plan/airinfo/dom-timetable/pdf/timetable_osaka_20261025_20270131.pdf' },
  { id: 'domestic-nagoya', title: 'ANA 国内線時刻表 東海（2026年冬ダイヤ）', url: 'https://www.ana.co.jp/guide/plan/airinfo/dom-timetable/pdf/timetable_tokai_20261025_20270131.pdf' },
  { id: 'award-reservation', title: 'ANA 特典航空券 予約・空席照会', url: 'https://www.ana.co.jp/ja/jp/guide/amc/award/' },
]

// name は空港名、city は結果一覧の都市名。region は表示用分類で、運賃ゾーンとは独立。
const airportRows: [string, string, string, string, string][] = [
  ['HND', '東京（羽田）', '東京', '日本', '関東'],
  ['NRT', '東京（成田）', '東京', '日本', '関東'],
  ['ITM', '大阪（伊丹）', '大阪', '日本', '関西'],
  ['KIX', '大阪（関西）', '大阪', '日本', '関西'],
  ['NGO', '名古屋（中部）', '名古屋', '日本', '中部・北陸'],
  ['CTS', '札幌（新千歳）', '札幌', '日本', '北海道'],
  ['AKJ', '旭川', '旭川', '日本', '北海道'],
  ['HKD', '函館', '函館', '日本', '北海道'],
  ['AOJ', '青森', '青森', '日本', '東北'],
  ['AXT', '秋田', '秋田', '日本', '東北'],
  ['SYO', '庄内', '庄内', '日本', '東北'],
  ['SDJ', '仙台', '仙台', '日本', '東北'],
  ['TOY', '富山', '富山', '日本', '中部・北陸'],
  ['KMQ', '小松', '金沢・小松', '日本', '中部・北陸'],
  ['HAC', '八丈島', '八丈島', '日本', '関東'],
  ['OKJ', '岡山', '岡山', '日本', '中国・四国'],
  ['HIJ', '広島', '広島', '日本', '中国・四国'],
  ['TAK', '高松', '高松', '日本', '中国・四国'],
  ['MYJ', '松山', '松山', '日本', '中国・四国'],
  ['KCZ', '高知', '高知', '日本', '中国・四国'],
  ['FUK', '福岡', '福岡', '日本', '九州'],
  ['OIT', '大分', '大分', '日本', '九州'],
  ['KMJ', '熊本', '熊本', '日本', '九州'],
  ['NGS', '長崎', '長崎', '日本', '九州'],
  ['KMI', '宮崎', '宮崎', '日本', '九州'],
  ['KOJ', '鹿児島', '鹿児島', '日本', '九州'],
  ['OKA', '沖縄（那覇）', '沖縄・那覇', '日本', '沖縄'],
  ['MMY', '宮古', '宮古島', '日本', '沖縄'],
  ['ISG', '石垣', '石垣島', '日本', '沖縄'],
  ['GMP', 'ソウル（金浦）', 'ソウル', '韓国', '韓国'],
  ['TSA', '台北（松山）', '台北', '台湾', '東アジア'],
  ['PEK', '北京（首都）', '北京', '中国', '東アジア'],
  ['PVG', '上海（浦東）', '上海', '中国', '東アジア'],
  ['SHA', '上海（虹橋）', '上海', '中国', '東アジア'],
  ['HKG', '香港', '香港', '香港', '東アジア'],
  ['MNL', 'マニラ', 'マニラ', 'フィリピン', '東南アジア'],
  ['SIN', 'シンガポール', 'シンガポール', 'シンガポール', '東南アジア'],
  ['BKK', 'バンコク（スワンナプーム）', 'バンコク', 'タイ', '東南アジア'],
  ['KUL', 'クアラルンプール', 'クアラルンプール', 'マレーシア', '東南アジア'],
  ['SGN', 'ホーチミン（タンソンニャット）', 'ホーチミン', 'ベトナム', '東南アジア'],
  ['HAN', 'ハノイ（ノイバイ）', 'ハノイ', 'ベトナム', '東南アジア'],
  ['CGK', 'ジャカルタ（スカルノハッタ）', 'ジャカルタ', 'インドネシア', '東南アジア'],
  ['DEL', 'デリー', 'デリー', 'インド', '南アジア'],
  ['BOM', 'ムンバイ', 'ムンバイ', 'インド', '南アジア'],
  ['HNL', 'ホノルル', 'ホノルル', 'アメリカ', 'ハワイ'],
  ['LAX', 'ロサンゼルス', 'ロサンゼルス', 'アメリカ', '北米'],
  ['SFO', 'サンフランシスコ', 'サンフランシスコ', 'アメリカ', '北米'],
  ['SEA', 'シアトル', 'シアトル', 'アメリカ', '北米'],
  ['JFK', 'ニューヨーク（JFK）', 'ニューヨーク', 'アメリカ', '北米'],
  ['ORD', 'シカゴ（オヘア）', 'シカゴ', 'アメリカ', '北米'],
  ['YVR', 'バンクーバー', 'バンクーバー', 'カナダ', '北米'],
  ['LHR', 'ロンドン（ヒースロー）', 'ロンドン', 'イギリス', 'ヨーロッパ'],
  ['CDG', 'パリ（シャルル・ド・ゴール）', 'パリ', 'フランス', 'ヨーロッパ'],
  ['FRA', 'フランクフルト', 'フランクフルト', 'ドイツ', 'ヨーロッパ'],
  ['MUC', 'ミュンヘン', 'ミュンヘン', 'ドイツ', 'ヨーロッパ'],
  ['BRU', 'ブリュッセル', 'ブリュッセル', 'ベルギー', 'ヨーロッパ'],
  ['SYD', 'シドニー', 'シドニー', 'オーストラリア', 'オセアニア'],
  ['PER', 'パース', 'パース', 'オーストラリア', 'オセアニア'],
]
export const AIRPORTS: Airport[] = airportRows.map(([code, name, city, country, region]) => ({ code, name, city, country, region }))

type Miles = Record<Season, number>
const miles = (L: number, R: number, H: number): Miles => ({ L, R, H })
/** 1人・片道。税金・空港使用料・燃油特別付加運賃を含まない。 */
export const PRICING: Record<string, Partial<Record<Cabin, Miles>>> = {
  'domestic-300': { economy: miles(6000, 6500, 9000) },
  'domestic-800': { economy: miles(7000, 8500, 10500) },
  'domestic-1000': { economy: miles(8000, 9500, 12000) },
  'domestic-2000': { economy: miles(9500, 10500, 13000) },
  'zone-2': { economy: miles(6000, 7500, 12000), business: miles(18000, 20500, 25000) },
  'zone-3': { economy: miles(8500, 10000, 15000), premium: miles(15000, 16500, 23500), business: miles(24000, 26500, 32500) },
  'zone-4': { economy: miles(15000, 17500, 25000), premium: miles(23000, 25500, 35500), business: miles(40000, 42500, 47500), first: miles(57500, 60000, 85500) },
  'zone-5': { economy: miles(17500, 20000, 32500), premium: miles(26500, 29000, 44000), business: miles(40000, 42500, 67500), first: miles(60000, 70000, 120000) },
  'zone-6': { economy: miles(20000, 25000, 36000), premium: miles(31000, 36000, 50500), business: miles(50000, 52500, 82500), first: miles(75000, 85000, 150000) },
  'zone-7': { economy: miles(22500, 27500, 39000), premium: miles(33500, 38500, 53500), business: miles(55000, 57500, 90000), first: miles(82500, 95000, 165000) },
  'zone-10': { economy: miles(18500, 22500, 32500), premium: miles(27000, 31000, 44000), business: miles(40000, 45000, 67500) },
}

export const PRICING_LABELS: Record<string, string> = {
  'domestic-300': '0〜300マイル区間', 'domestic-800': '301〜800マイル区間',
  'domestic-1000': '801〜1,000マイル区間', 'domestic-2000': '1,001〜2,000マイル区間',
  'zone-2': 'Zone 2 韓国・ロシア1', 'zone-3': 'Zone 3 アジア1', 'zone-4': 'Zone 4 アジア2',
  'zone-5': 'Zone 5 ハワイ', 'zone-6': 'Zone 6 北米', 'zone-7': 'Zone 7 欧州・ロシア2', 'zone-10': 'Zone 10 オセアニア',
}

// 国内は公式チャートの距離帯を使用。時刻表に記載された空港ペアを両方向に展開する。
const domesticPairs: [string, string, number, string][] = [
  ...['AXT', 'SYO', 'TOY', 'KMQ', 'HAC', 'ITM', 'KIX', 'NGO'].map((to): [string, string, number, string] => ['HND', to, 300, 'domestic-tokyo']),
  ...['CTS', 'AKJ', 'HKD', 'OKJ', 'HIJ', 'TAK', 'MYJ', 'KCZ', 'FUK', 'OIT', 'KMJ', 'NGS', 'KMI', 'KOJ'].map((to): [string, string, number, string] => ['HND', to, 800, 'domestic-tokyo']),
  ['HND', 'OKA', 1000, 'domestic-tokyo'], ['HND', 'MMY', 2000, 'domestic-tokyo'], ['HND', 'ISG', 2000, 'domestic-tokyo'],
  ['NRT', 'ITM', 300, 'domestic-osaka'], ['NRT', 'NGO', 300, 'domestic-nagoya'],
  ...['MYJ', 'KCZ', 'FUK', 'OIT', 'KMJ', 'KMI'].map((to): [string, string, number, string] => ['ITM', to, 300, 'domestic-osaka']),
  ...['CTS', 'HKD', 'AOJ', 'AXT', 'SDJ', 'NGS', 'KOJ', 'OKA'].map((to): [string, string, number, string] => ['ITM', to, 800, 'domestic-osaka']),
  ['NGO', 'MYJ', 300, 'domestic-nagoya'],
  ...['CTS', 'HKD', 'AXT', 'SDJ', 'FUK', 'OIT', 'NGS', 'KMI', 'KOJ'].map((to): [string, string, number, string] => ['NGO', to, 800, 'domestic-nagoya']),
  ['NGO', 'OKA', 1000, 'domestic-nagoya'], ['NGO', 'MMY', 1000, 'domestic-nagoya'], ['NGO', 'ISG', 2000, 'domestic-nagoya'],
]

// 国際線は公表済み2026年夏・冬ダイヤの運航路線の一部。運休路線は含めない。
const internationalPairs: [string, string, number][] = [
  ['HND', 'GMP', 2], ['HND', 'TSA', 3], ['HND', 'PEK', 3], ['HND', 'PVG', 3], ['HND', 'SHA', 3], ['HND', 'HKG', 3], ['HND', 'MNL', 3],
  ['NRT', 'PVG', 3], ['NRT', 'HKG', 3], ['NRT', 'MNL', 3], ['KIX', 'PEK', 3], ['KIX', 'PVG', 3],
  ['HND', 'SIN', 4], ['HND', 'BKK', 4], ['HND', 'KUL', 4], ['HND', 'SGN', 4], ['HND', 'CGK', 4], ['HND', 'DEL', 4],
  ['NRT', 'SIN', 4], ['NRT', 'BKK', 4], ['NRT', 'KUL', 4], ['NRT', 'SGN', 4], ['NRT', 'HAN', 4], ['NRT', 'CGK', 4], ['NRT', 'BOM', 4],
  ['HND', 'HNL', 5], ['NRT', 'HNL', 5],
  ['HND', 'LAX', 6], ['HND', 'SFO', 6], ['HND', 'SEA', 6], ['HND', 'JFK', 6], ['HND', 'ORD', 6], ['HND', 'YVR', 6],
  ['NRT', 'LAX', 6], ['NRT', 'SFO', 6], ['NRT', 'ORD', 6],
  ['HND', 'LHR', 7], ['HND', 'CDG', 7], ['HND', 'FRA', 7], ['HND', 'MUC', 7], ['NRT', 'BRU', 7],
  ['HND', 'SYD', 10], ['NRT', 'PER', 10],
]
const airportByCode = new Map(AIRPORTS.map((airport) => [airport.code, airport]))
const regionFor = (code: string): string => airportByCode.get(code)!.region
export const ROUTES: AwardRoute[] = [
  ...domesticPairs.flatMap(([from, to, band, source]) => [[from, to], [to, from]].map(([origin, destination]) => ({
    id: `${origin}-${destination}`, origin, destination, kind: 'domestic' as const,
    region: regionFor(destination), pricingKey: `domestic-${band}`, seasonGroup: 'domestic' as const,
    sourceIds: ['domestic-chart', source],
  }))),
  ...internationalPairs.map(([origin, destination, zone]) => ({
    id: `${origin}-${destination}`, origin, destination, kind: 'international' as const,
    region: regionFor(destination), pricingKey: `zone-${zone}`,
    seasonGroup: (zone <= 4 ? 'asia' : zone === 5 || zone === 10 ? 'pacific' : 'western') as SeasonGroup,
    sourceIds: ['international-chart', 'international-routes'],
  })),
]

const ranges = (year: number, season: Season, dates: string[]): SeasonRange[] => dates.map((date) => {
  const [start, end] = date.split('~')
  return { start: `${year}-${start}`, end: `${year}-${end ?? start}`, season }
})
/** 公表範囲外をR扱いなどに補完しない。全期間は両端を含む。 */
export const SEASON_CALENDARS: Record<SeasonGroup, SeasonRange[]> = {
  domestic: [
    ...ranges(2026, 'L', ['12-01~12-23']),
    ...ranges(2026, 'R', ['05-19~07-17', '08-31~11-30']),
    ...ranges(2026, 'H', ['07-18~08-30', '12-24~12-31']),
    ...ranges(2027, 'L', ['01-07~02-28', '04-01~04-27', '12-01~12-27']),
    ...ranges(2027, 'R', ['03-01~03-11', '05-11~07-15', '08-23~09-16', '09-21~09-22', '09-27~09-30', '11-24~11-30']),
    ...ranges(2027, 'H', ['01-01~01-06', '03-12~03-31', '04-28~05-10', '07-16~08-22', '09-17~09-20', '09-23~09-26', '10-01~11-23', '12-28~12-31']),
    ...ranges(2028, 'L', ['01-13~02-09', '02-14~02-29']),
    ...ranges(2028, 'R', ['03-01~03-09']),
    ...ranges(2028, 'H', ['01-01~01-12', '02-10~02-13', '03-10~03-31']),
  ],
  asia: [
    ...ranges(2026, 'L', ['01-05~02-13', '04-01~04-28', '05-11~06-30']),
    ...ranges(2026, 'R', ['02-14~03-31', '07-01~07-17', '08-24~12-20']),
    ...ranges(2026, 'H', ['01-01~01-04', '04-29~05-10', '07-18~08-23', '12-21~12-31']),
    ...ranges(2027, 'L', ['01-05~02-03', '04-12~04-28', '05-10~06-30', '12-01~12-19']),
    ...ranges(2027, 'R', ['02-07~03-31', '04-01~04-11', '07-01~07-15', '08-24~09-30', '10-08~11-30']),
    ...ranges(2027, 'H', ['01-01~01-04', '02-04~02-06', '04-29~05-09', '07-16~08-23', '10-01~10-07', '12-20~12-31']),
    ...ranges(2028, 'L', ['01-05~01-24']),
    ...ranges(2028, 'R', ['02-01~03-31']),
    ...ranges(2028, 'H', ['01-01~01-04', '01-25~01-31']),
  ],
  western: [
    ...ranges(2026, 'L', ['01-06~02-28', '04-01~04-28']),
    ...ranges(2026, 'R', ['01-04~01-05', '03-01~03-31', '05-10~07-15', '08-24~12-18']),
    ...ranges(2026, 'H', ['01-01~01-03', '04-29~05-09', '07-16~08-23', '12-19~12-31']),
    ...ranges(2027, 'L', ['01-06~02-28']),
    ...ranges(2027, 'R', ['01-04~01-05', '03-01~04-28', '05-10~07-15', '08-23~12-19']),
    ...ranges(2027, 'H', ['01-01~01-03', '04-29~05-09', '07-16~08-22', '12-20~12-31']),
    ...ranges(2028, 'L', ['01-06~02-29']),
    ...ranges(2028, 'R', ['01-04~01-05', '03-01~03-31']),
    ...ranges(2028, 'H', ['01-01~01-03']),
  ],
  pacific: [
    ...ranges(2026, 'L', ['01-07~02-28', '04-01~04-27', '05-10~05-31', '07-01~07-15']),
    ...ranges(2026, 'R', ['01-04~01-06', '03-01~03-31', '06-01~06-30', '08-24~12-18']),
    ...ranges(2026, 'H', ['01-01~01-03', '04-28~05-09', '07-16~08-23', '12-19~12-31']),
    ...ranges(2027, 'L', ['01-06~02-28', '04-01~04-28', '05-10~05-31']),
    ...ranges(2027, 'R', ['01-04~01-05', '03-01~03-31', '06-01~07-15', '08-23~12-19']),
    ...ranges(2027, 'H', ['01-01~01-03', '04-29~05-09', '07-16~08-22', '12-20~12-31']),
    ...ranges(2028, 'L', ['01-06~02-29']),
    ...ranges(2028, 'R', ['01-04~01-05', '03-01~03-31']),
    ...ranges(2028, 'H', ['01-01~01-03']),
  ],
}
