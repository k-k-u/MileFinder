import { describe, expect, it } from 'vitest'
import { parseAnaChatPage } from './anaChat'

const range = { dateFrom: '2026-10-01', dateTo: '2026-10-01' }
const observedPage = `検索結果をご案内いたします。
ご案内できる席数には限りがあります。
-----
1)直行便  
NH184便  
東京(成田) - ホノルル(オアフ島)  
エコノミークラス  
10/01 20:10発 0席  
プレミアムエコノミー  
10/01 20:10発 0席  
ビジネスクラス  
10/01 20:10発 0席  
ファーストクラス  
10/01 20:10発 0席  
-------------
2)直行便  
NH186便  
東京(羽田) - ホノルル(オアフ島)  
エコノミークラス  
10/01 21:55発 2席  
プレミアムエコノミー  
10/01 21:55発 0席  
ビジネスクラス  
10/01 21:55発 0席  
######
検索結果をさらに表示いたしますか？
翌日の空席結果が含まれる場合もございます。
「はい」または「いいえ」を入力してください。`

const block = (rows: string, extra = '') => `1)直行便
NH184便 東京(成田) - ホノルル(オアフ島)
エコノミークラス
${rows}${extra}`

describe('ANA公開チャットの実応答解析', () => {
  it('観測したページの2便・全クラスを解析し、0席と2席を保持する', () => {
    const result = parseAnaChatPage(observedPage, range)
    expect(result.recognized).toBe(true)
    expect(result.hasMore).toBe(true)
    expect(result.offers).toHaveLength(7)
    expect(result.offers.filter(offer => offer.seats === 0)).toHaveLength(6)
    expect(result.offers.find(offer => offer.seats === 2)).toEqual({
      flightNumber: 'NH186',
      originLabel: '東京(羽田)',
      destinationLabel: 'ホノルル(オアフ島)',
      date: '2026-10-01',
      time: '21:55',
      cabin: 'economy',
      seats: 2,
      source: 'ana-public-chat',
      accountScope: 'anonymous',
    })
    expect(result.offers.slice(0, 4).map(offer => offer.cabin)).toEqual(['economy', 'premium', 'business', 'first'])
  })

  it('便名と区間が同一行の次ページを解析する', () => {
    const page = `1)直行便
NH184便 東京(成田) - ホノルル(オアフ島)
エコノミークラス
10/02 20:10発 4席
-------------
2)直行便
NH182便 東京(成田) - ホノルル(オアフ島)
エコノミークラス
10/02 21:10発 9席
ビジネスクラス
10/02 21:10発 1席`
    const result = parseAnaChatPage(page, { ...range, dateTo: '2026-10-02' })
    expect(result.recognized).toBe(true)
    expect(result.hasMore).toBe(false)
    expect(result.offers.map(offer => [offer.flightNumber, offer.seats])).toEqual([['NH184', 4], ['NH182', 9], ['NH182', 1]])
  })

  it('0席だけでも解釈成功として未照会と区別する', () => {
    const result = parseAnaChatPage(block('10/01 20:10発 0席'), range)
    expect(result.recognized).toBe(true)
    expect(result.offers[0].seats).toBe(0)
  })

  it('CRLFと行末空白を許容する', () => {
    expect(parseAnaChatPage(observedPage.replace(/\n/g, '\r\n'), range)).toEqual(parseAnaChatPage(observedPage, range))
  })

  it('検索範囲外の翌日回答を取り除き、範囲外のみなら解釈成功としない', () => {
    const page = block('10/02 20:10発 4席', '\n######\n検索結果をさらに表示いたしますか？')
    expect(parseAnaChatPage(page, range)).toEqual({ offers: [], recognized: false, hasMore: true })
    const mixed = parseAnaChatPage(block('10/01 20:10発 2席\n10/02 20:10発 4席'), range)
    expect(mixed.offers.map(offer => offer.date)).toEqual(['2026-10-01'])
  })

  it('年を検索期間から一意に解決して年跨ぎを扱う', () => {
    const result = parseAnaChatPage(block('12/31 20:10発 2席\n01/01 20:10発 3席'), {
      dateFrom: '2026-12-31', dateTo: '2027-01-01',
    })
    expect(result.offers.map(offer => offer.date)).toEqual(['2026-12-31', '2027-01-01'])
  })

  it('同じ月日が複数年に該当する場合は年を推測しない', () => {
    expect(parseAnaChatPage(block('10/01 20:10発 2席'), {
      dateFrom: '2026-01-01', dateTo: '2027-12-31',
    }).recognized).toBe(false)
  })

  it('実在するうるう日だけを解決する', () => {
    const page = block('02/29 20:10発 2席')
    expect(parseAnaChatPage(page, { dateFrom: '2028-02-28', dateTo: '2028-03-01' }).offers[0].date).toBe('2028-02-29')
    expect(parseAnaChatPage(page, { dateFrom: '2027-02-28', dateTo: '2027-03-01' }).recognized).toBe(false)
  })

  it.each([
    { dateFrom: '2026-02-29', dateTo: '2026-10-01' },
    { dateFrom: '2026-10-01', dateTo: '2026-13-01' },
    { dateFrom: '2026-10-02', dateTo: '2026-10-01' },
    { dateFrom: '', dateTo: '2026-10-01' },
  ])('不正な検索期間では回答を解釈しない: %j', invalidRange => {
    expect(parseAnaChatPage(observedPage, invalidRange).recognized).toBe(false)
  })
})

describe('日時と席数が別行になった回答', () => {
  it('復路で観測した書式で2便・7クラスの0席回答を読み取る', () => {
    const page = `1)直行便
NH183便
ホノルル(オアフ島) - 東京(成田)
エコノミークラス
10/05 11:50発
0席

プレミアムエコノミー
10/05 11:50発
0席
ビジネスクラス
10/05 11:50発
0席
ファーストクラス
10/05 11:50発
0席
-------------
2)直行便
NH185便
ホノルル(オアフ島) - 東京(羽田)
エコノミークラス
10/05 13:55発
0席
プレミアムエコノミー
10/05 13:55発
0席
ビジネスクラス
10/05 13:55発
0席
######
検索結果をさらに表示いたしますか？`
    const result = parseAnaChatPage(page, { dateFrom: '2026-10-05', dateTo: '2026-10-05' })
    expect(result.recognized).toBe(true)
    expect(result.hasMore).toBe(true)
    expect(result.offers).toHaveLength(7)
    expect(result.offers.every(offer => offer.seats === 0 && offer.date === '2026-10-05' && offer.originLabel === 'ホノルル(オアフ島)')).toBe(true)
    expect(result.offers.slice(0, 4).every(offer => offer.flightNumber === 'NH183' && offer.time === '11:50' && offer.destinationLabel === '東京(成田)')).toBe(true)
    expect(result.offers.slice(4).every(offer => offer.flightNumber === 'NH185' && offer.time === '13:55' && offer.destinationLabel === '東京(羽田)')).toBe(true)
  })

  it.each([0, 2, 9])('別行の%d席を整数として保持し、空白行を許容する', seats => {
    const result = parseAnaChatPage(block(`10/01 20:10発  \n\n${seats}席  `), range)
    expect(result.offers).toHaveLength(1)
    expect(result.offers[0].seats).toBe(seats)
  })

  it('同じ便・クラス内で同行版と別行版が混在しても日時とクラスを保つ', () => {
    const page = block(`10/01 20:10発
2席
10/02 20:10発 1席
プレミアムエコノミー
10/01 20:10発 0席
ビジネスクラス
10/01 20:10発
3席`)
    const result = parseAnaChatPage(page, { ...range, dateTo: '2026-10-02' })
    expect(result.offers.map(offer => [offer.date, offer.cabin, offer.seats])).toEqual([
      ['2026-10-01', 'economy', 2], ['2026-10-02', 'economy', 1],
      ['2026-10-01', 'premium', 0], ['2026-10-01', 'business', 3],
    ])
  })

  it.each([
    '10/01 20:10発',
    '10/01 20:10発\nビジネスクラス\n2席',
    '10/01 20:10発\nビジネスクラス\n10/01 20:10発\n2席',
    '10/01 20:10発\n10/02 20:10発\n2席',
    '10/01 20:10発\n-----\n2席',
    '10/01 20:10発\n残りわずか',
    '10/01 20:10発\n-1席',
    '10/01 20:10発\n1.5席',
    '10/01 20:10発\n99999999999999999999席',
    '10/32 20:10発\n2席',
    '10/01 25:10発\n2席',
  ])('欠落・クラス跨ぎ・次日時・不正値を誤結合しない: %s', rows => {
    const result = parseAnaChatPage(block(rows), { ...range, dateTo: '2026-10-02' })
    expect(result.recognized).toBe(false)
    expect(result.offers).toEqual([])
  })

  it('不完全な前便の日時に次便の席数を結び付けない', () => {
    const page = `${block('10/01 20:10発')}
2)直行便
NH186便 東京(羽田) - ホノルル(オアフ島)
エコノミークラス
10/01 21:55発
3席`
    const result = parseAnaChatPage(page, range)
    expect(result.offers).toHaveLength(1)
    expect(result.offers[0].flightNumber).toBe('NH186')
    expect(result.offers[0].time).toBe('21:55')
    expect(result.offers[0].seats).toBe(3)
  })

  it('別行版でも年を一意に決め、期間外の復路日を除外する', () => {
    const page = block('12/31 20:10発\n2席\n01/01 20:10発\n3席\n01/02 20:10発\n4席')
    const result = parseAnaChatPage(page, { dateFrom: '2026-12-31', dateTo: '2027-01-01' })
    expect(result.offers.map(offer => [offer.date, offer.seats])).toEqual([['2026-12-31', 2], ['2027-01-01', 3]])
  })
})

describe('0席と空席待ち可能の区別', () => {
  it('コードフェンス内の実WS書式を読み、空席待ち人数の照会案内を次ページ案内とみなさない', () => {
    const page = [
      '```',
      '1)直行便',
      'NH183便\tホノルル(オアフ島) - 東京(成田)',
      'エコノミークラス',
      '10/06 11:50発\t0席(空席待ち可能)',
      '-------',
      '2)直行便',
      'NH181便\tホノルル(オアフ島) - 東京(成田)',
      'ビジネスクラス',
      '10/06 13:00発\t0席(空席待ち可能)',
      '-------',
      '3)直行便',
      'NH185便\tホノルル(オアフ島) - 東京(羽田)',
      'プレミアムエコノミー',
      '10/06 13:55発\t0席(空席待ち可能)',
      '-------',
      '```',
      '######',
      '検索結果に空席待ち可能な便がございます。',
      '空席状況の確認を終了し、空席待ち人数をお調べいたしますか？',
      '「はい」または「いいえ」を入力してください。',
    ].join('\n')
    const result = parseAnaChatPage(page, { dateFrom: '2026-10-06', dateTo: '2026-10-06' })
    expect(result.recognized).toBe(true)
    expect(result.hasMore).toBe(false)
    expect(result.offers.map(offer => [offer.flightNumber, offer.time, offer.cabin, offer.seats, offer.waitlistAvailable])).toEqual([
      ['NH183', '11:50', 'economy', 0, true],
      ['NH181', '13:00', 'business', 0, true],
      ['NH185', '13:55', 'premium', 0, true],
    ])
  })

  it('空席待ち可能を同じ日時の0席にだけ付け、通常の0席や正数と区別する', () => {
    const result = parseAnaChatPage(block('10/01 20:10発 0席\n10/02 20:10発 0席(空席待ち可能)\n10/03 20:10発 2席'), {
      ...range, dateTo: '2026-10-03',
    })
    expect(result.offers).toHaveLength(3)
    expect(result.offers[0]).not.toHaveProperty('waitlistAvailable')
    expect(result.offers[1]).toHaveProperty('waitlistAvailable', true)
    expect(result.offers[2]).not.toHaveProperty('waitlistAvailable')
    expect(result.offers.map(offer => offer.seats)).toEqual([0, 0, 2])
  })

  it('席数が別行でも0席の空席待ち表記を同じ日時へ対応させる', () => {
    const result = parseAnaChatPage(block('10/01 20:10発\n0席(空席待ち可能)'), range)
    expect(result.offers[0]).toMatchObject({ seats: 0, date: '2026-10-01', waitlistAvailable: true })
  })

  it.each([
    '10/01 20:10発 1席(空席待ち可能)',
    '10/01 20:10発\n2席(空席待ち可能)',
    '10/01 20:10発 0席(空席待ち不可)',
    '10/01 20:10発 0席(不明)',
    '10/01 20:10発 0席(空席待ち可能) その他',
    '10/01 20:10発\n0席(不明)',
  ])('未観測の正数との組合せや未知suffixは採用しない: %s', rows => {
    expect(parseAnaChatPage(block(rows), range).recognized).toBe(false)
  })
})

describe('未知・不完全な回答を空席なしへ変換しない', () => {
  it.each([
    '',
    'システムエラーが発生しました。時間をおいて再度お試しください。',
    '検索条件に一致する空席はありません。',
    '検索結果をさらに表示いたしますか？',
    'NH184便 東京(成田) - ホノルル(オアフ島)\nエコノミークラス\n10/01 20:10発 2席',
    '1)乗継便\nNH184便 東京(成田) - ホノルル(オアフ島)\nエコノミークラス\n10/01 20:10発 0席',
    block('10/01 20:10発 残りわずか'),
    block('10/01 20:10発 空席待ち'),
    block('10/01 20:10発 -1席'),
    block('10/01 25:10発 2席'),
    block('10/01 20:61発 2席'),
    block('13/01 20:10発 2席'),
    block('10/32 20:10発 2席'),
    block('10/01 20:10発 99999999999999999999席'),
    block(''),
    block('10/01 20:10発 2席').replace('エコノミークラス', '不明なクラス'),
    block('10/01 20:10発 2席').replace('エコノミークラス', 'constructor'),
    block('10/01 20:10発 2席').replace('NH184便', '便名不明'),
    block('10/01 20:10発 2席').replace(' - ', ' → '),
  ])('非対応回答はrecognized=false: %s', page => {
    const result = parseAnaChatPage(page, range)
    expect(result.recognized).toBe(false)
    expect(result.offers).toEqual([])
  })

  it('解釈不能な行を含む便は部分的に採用しない', () => {
    const page = block('10/01 20:10発 2席\nビジネスクラス\n10/01 20:10発 空席待ち')
    expect(parseAnaChatPage(page, range).recognized).toBe(false)
  })

  it('直行便と乗継便が混在しても、乗継便へ直行便のクラスや便名を引き継がない', () => {
    const page = `${block('10/01 20:10発 2席')}
2)乗継便
NH182便 東京(成田) - ホノルル(オアフ島)
ビジネスクラス
10/01 21:10発 0席`
    const result = parseAnaChatPage(page, range)
    expect(result.offers).toHaveLength(1)
    expect(result.offers[0].flightNumber).toBe('NH184')
    expect(result.offers[0].cabin).toBe('economy')
  })
})
