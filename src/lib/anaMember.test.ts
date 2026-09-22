import { describe, expect, it } from 'vitest'
import { parseMemberScript } from './anaMember'
import type { MemberQuery } from './anaMember'

const query: MemberQuery = {
  origin: 'TYO', destination: 'HNL', departureDate: '2026-10-02', returnDate: '2026-10-05',
  cabin: 'economy', passengers: 1,
}
const observedRecommendation = "addRecommendation(2,0,0,'1400','1400',null,null,90250.0,false,0,0,40000,'NO_NO_RULE','NO_NO_RULE',6,0,0.0,90250.0,0,'','',false,'',[{segmentInfoList : [{serviceLevel : 1400}]},{segmentInfoList : [{serviceLevel : 1400}]}]);"
const outbound = "addOutboundSegmentInfoMap('0_0','NH','186','HND','HNL','X','20261002');"
const inbound = "addInboundSegmentInfoMap('0_0','NH','183','HNL','NRT','X','20261005');"
const observed = `${outbound}\n${inbound}\n${observedRecommendation}`

function recommendation(changes: Partial<Record<number, string>> = {}): string {
  const args = ['2', '0', '0', "'1400'", "'1400'", 'null', 'null', '90250.0', 'false', '0', '0',
    '40000', "'NO_NO_RULE'", "'NO_NO_RULE'", '6', '0', '0.0', '90250.0', '0', "''", "''", 'false', "''",
    '[{segmentInfoList : [{serviceLevel : 1400}]},{segmentInfoList : [{serviceLevel : 1400}]}]']
  for (const [index, value] of Object.entries(changes)) if (value !== undefined) args[Number(index)] = value
  return `addRecommendation(${args.join(',')});`
}
function wrapped(out = outbound, back = inbound, recommendations = observedRecommendation): string {
  return `<html><body><script>
    function addRecommendation(a, b) { return { a: a, b: b }; }
    function resetData() {
      recommendationList = new Array();
      addFareFamily('unrelated', false);
      ${recommendations}
      addFormatedRecommendation('unrelated');
    }
    function createOutboundSegmentInfoMap() { outboundSegmentInfoMap = {}; ${out} }
    function createInboundSegmentInfoMap() { inboundSegmentInfoMap = {}; ${back} }
  </script></body></html>`
}

describe('ANA会員検索の観測済みliteral応答', () => {
  it('観測した呼出から公式の往復料金・席数・区間を読む', () => {
    expect(parseMemberScript(observed, query)).toEqual([{
      outbound: [{ flightNumber: 'NH186', origin: 'HND', destination: 'HNL', date: '2026-10-02', bookingClass: 'X' }],
      inbound: [{ flightNumber: 'NH183', origin: 'HNL', destination: 'NRT', date: '2026-10-05', bookingClass: 'X' }],
      outboundSeats: 6, inboundSeats: 0, totalMiles: 40000, totalCashJpy: 90250,
    }])
  })

  it('実応答の3つのデータ関数内を実行せず読む', () => {
    expect(parseMemberScript(wrapped(), query)).toEqual(parseMemberScript(observed, query))
  })

  it('6組合せを配列順でなくrecommendationの区間IDで対応付ける', () => {
    const out = [outbound.replace("'0_0'", "'7_0'"), outbound.replace("'186'", "'184'").replace("'HND'", "'NRT'")].join('\n')
    const back = [inbound.replace("'0_0'", "'9_0'").replace("'183'", "'185'").replace("'NRT'", "'HND'"),
      inbound, inbound.replace("'0_0'", "'2_0'").replace("'183'", "'181'")].join('\n')
    const recs = [0, 7].flatMap(outId => [2, 9, 0].map(inId => recommendation({ 1: String(outId), 2: String(inId), 14: String(outId === 7 ? 6 : 3) }))).join('\n')
    const results = parseMemberScript(wrapped(out, back, recs), query)
    expect(results).toHaveLength(6)
    expect(results.map(result => [result.outbound[0].flightNumber, result.inbound[0].flightNumber])).toEqual([
      ['NH184', 'NH181'], ['NH184', 'NH185'], ['NH184', 'NH183'],
      ['NH186', 'NH181'], ['NH186', 'NH185'], ['NH186', 'NH183'],
    ])
  })

  it('2名の応答合計を再乗算せず、0席と人数不足も残す', () => {
    const source = wrapped(outbound, inbound, recommendation({ 7: '180920', 11: '80000', 14: '1', 15: '0' }))
    expect(parseMemberScript(source, { ...query, passengers: 2 })[0]).toMatchObject({
      totalMiles: 80000, totalCashJpy: 180920, outboundSeats: 1, inboundSeats: 0,
    })
  })

  it('TYOではHND発NRT着を認め、HND固定では他空港の復路を含めない', () => {
    expect(parseMemberScript(observed, query)).toHaveLength(1)
    expect(() => parseMemberScript(observed, { ...query, origin: 'HND' })).toThrow('空席なしとは判定していません')
    expect(parseMemberScript(observed.replace("'HNL','NRT'", "'HNL','HND'"), { ...query, origin: 'HND' })).toHaveLength(1)
  })

  it('往路・復路は各出発地の実日付を年跨ぎでも照合する', () => {
    const source = observed.replace('20261002', '20261231').replace('20261005', '20270103')
    expect(parseMemberScript(source, { ...query, departureDate: '2026-12-31', returnDate: '2027-01-03' })).toHaveLength(1)
    expect(() => parseMemberScript(source, { ...query, departureDate: '2026-12-31', returnDate: '2027-01-04' })).toThrow()
  })

  it('XMLのevalとCDATAを解析し、HTML本文や属性の偽callは読まない', () => {
    const xml = `<partial-response><changes><eval><![CDATA[${observed}]]></eval></changes></partial-response>`
    expect(parseMemberScript(xml, query)).toHaveLength(1)
    const html = `<div title="addRecommendation(unknown)">${observed}</div><script>${observed}</script>`
    expect(parseMemberScript(html, query)).toHaveLength(1)
    expect(() => parseMemberScript(`<p>${observed}</p>`, query)).toThrow()
  })

  it('同一内容の重複区間とrecommendationを1旅程へまとめる', () => {
    expect(parseMemberScript(`${observed}\n${outbound}\n${inbound}\n${observedRecommendation}`, query)).toHaveLength(1)
  })

  it('未知のキャリアや予約クラスは推測せず、条件が一致する行だけ読む', () => {
    const extras = `${outbound.replace("'0_0'", "'1_0'").replace("'NH'", "'UA'")}\n${outbound.replace("'0_0'", "'2_0'").replace("'X'", "'I'")}`
    expect(parseMemberScript(`${observed}\n${extras}\n${recommendation({ 1: '1' })}\n${recommendation({ 1: '2' })}`, query)).toHaveLength(1)
  })

  it('乗継の区間を勝手に1便へ短縮しない', () => {
    const source = `${observed}\n${outbound.replace("'0_0'", "'0_1'")}`
    expect(() => parseMemberScript(source, query)).toThrow('指定条件に対応する旅程')
  })
})

describe('会員応答の未確認状態を空席なしに変換しない', () => {
  it.each(['', 'ログインが必要です', '[]', 'function addRecommendation() {}', outbound + inbound])('空・未知・recommendationなし: %s', source => {
    expect(() => parseMemberScript(source, query)).toThrow('空席なしとは判定していません')
  })

  it.each([
    observed.replace("'20261002'", "'20260230'"),
    observed.replace("'20261005'", "'20261006'"),
    observed.replace("'HND','HNL'", "'HND','LAX'"),
    observed.replace("'NH'", "'UA'"),
    observed.replace("'X'", "'I'"),
    `${inbound}\n${observedRecommendation}`,
    `${outbound}\n${inbound}\n${recommendation({ 1: '999' })}`,
    `${observed}\n${outbound.replace("'186'", "'999'")}`,
  ])('不正・不一致・欠落・競合する区間を拒否する %#', source => {
    expect(() => parseMemberScript(source, query)).toThrow()
  })

  it.each([
    { cabin: 'business' as const }, { cabin: 'premium' as const }, { cabin: 'first' as const },
    { passengers: 0 }, { passengers: 10 }, { passengers: 1.5 },
    { departureDate: '2026-02-30' }, { returnDate: '2026-09-30' }, { origin: 'tyo' }, { destination: 'TYO' },
  ])('未観測クラスや不正queryを拒否する %o', changes => {
    expect(() => parseMemberScript(observed, { ...query, ...changes })).toThrow()
  })

  it.each([
    { 7: '-1' }, { 7: '10.5' }, { 7: "'90250'" }, { 11: '0' }, { 11: '1e309' },
    { 14: 'null' }, { 14: '-1' }, { 14: '1.5' }, { 15: 'false' }, { 15: '9007199254740992' },
  ])('不明な料金や席数を0扱いにしない %o', changes => {
    expect(() => parseMemberScript(`${outbound}\n${inbound}\n${recommendation(changes)}`, query)).toThrow()
  })
})

describe('外部JavaScriptを実行しない限定parser', () => {
  it('同名functionの定義・無関係な関数内・文字列・コメント・正規表現を呼出と誤認しない', () => {
    const source = `
      function addRecommendation(a) { ${recommendation({ 11: '99999' })} }
      function unrelated() { ${recommendation({ 11: '99999' })} }
      const fake = ${JSON.stringify(recommendation({ 11: '99999' }))};
      // ${recommendation({ 11: '99999' })}
      /* ${recommendation({ 11: '99999' })} */
      const expression = /addRecommendation(unknown);/;
      ${observed}
    `
    expect(parseMemberScript(source, query).map(result => result.totalMiles)).toEqual([40000])
  })

  it('データ関数内の対応しない別種callや入れ子のcallは採用しない', () => {
    const source = wrapped(outbound, inbound, `${observedRecommendation}\nfunction nested() { ${recommendation({ 11: '99999' })} }`)
    expect(parseMemberScript(source, query)).toHaveLength(1)
    expect(() => parseMemberScript(wrapped(outbound + observedRecommendation, inbound, ''), query)).toThrow()
  })

  it.each([
    { 7: '(globalThis.__anaMemberExecuted = true, 1)' },
    { 7: 'Number(90250)' }, { 7: '90250 + 1' }, { 7: 'undefined' },
    { 23: '[{get segmentInfoList() { globalThis.__anaMemberExecuted = true; }}]' },
    { 23: '[{["segmentInfoList"]: []}]' }, { 23: '[...[]]' },
    { 23: '[{a: function () { globalThis.__anaMemberExecuted = true; }}]' },
    { 23: '[{a: 1, a: 2}]' },
  ])('literal以外の引数を実行せず拒否する %#', changes => {
    expect(() => parseMemberScript(`${outbound}\n${inbound}\n${recommendation(changes)}`, query)).toThrow()
    expect(Object.hasOwn(globalThis, '__anaMemberExecuted')).toBe(false)
  })

  it('callに続くメソッドや代入を拒否する', () => {
    const call = observedRecommendation.slice(0, -1)
    expect(() => parseMemberScript(`${outbound}\n${inbound}\n${call}.execute();`, query)).toThrow()
    expect(() => parseMemberScript(`${outbound}\n${inbound}\n${call} = 0;`, query)).toThrow()
  })

  it('オブジェクトのprototype名を実行しない', () => {
    const source = `${outbound}\n${inbound}\n${recommendation({ 23: '[{__proto__: {__anaMemberPolluted: true}}]' })}`
    expect(parseMemberScript(source, query)).toHaveLength(1)
    expect(Object.hasOwn(Object.prototype, '__anaMemberPolluted')).toBe(false)
  })

  it('入力サイズ・1callサイズ・call件数・literal深さ・要素数に上限を置く', () => {
    expect(() => parseMemberScript(' '.repeat(4_000_001), query)).toThrow('サイズ')
    expect(() => parseMemberScript(`${outbound}\n${inbound}\n${recommendation({ 22: `'${'x'.repeat(64_001)}'` })}`, query)).toThrow('上限')
    expect(() => parseMemberScript(`${outbound}\n${inbound}\n${observedRecommendation.repeat(2_001)}`, query)).toThrow('上限')
    expect(() => parseMemberScript(`${outbound}\n${inbound}\n${recommendation({ 23: '['.repeat(18) + '0' + ']'.repeat(18) })}`, query)).toThrow('上限')
    expect(() => parseMemberScript(`${outbound}\n${inbound}\n${recommendation({ 23: `[${'0,'.repeat(10_000)}0]` })}`, query)).toThrow('上限')
  })

  it('自作関数のtoStringだけで復元でき、モジュール外helperを必要としない', () => {
    // 評価するのは自作parserのみ。ANA応答は常に単なる引数として渡す。
    const restored = new Function(`return (${parseMemberScript.toString()});`)() as typeof parseMemberScript
    expect(restored(wrapped(), query)).toEqual(parseMemberScript(wrapped(), query))
  })
})
