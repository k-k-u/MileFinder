import type { Cabin } from '../data/awards'

export interface MemberQuery {
  origin: string
  destination: string
  departureDate: string
  returnDate: string
  cabin: Cabin
  passengers: number
}

export interface MemberSegment {
  flightNumber: string
  origin: string
  destination: string
  date: string
  bookingClass: string
}

export interface MemberItinerary {
  outbound: MemberSegment[]
  inbound: MemberSegment[]
  outboundSeats: number
  inboundSeats: number
  /** 会員応答の旅程・全員合計。人数を再乗算しない。 */
  totalMiles: number
  totalCashJpy: number
}

/**
 * 観測済みの会員検索scriptのliteral呼出だけを解析する。外部JavaScriptを実行しない。
 * 自作bookmarkletへの埋め込み用に、実行時の依存はこの関数内と標準組み込みに限定する。
 */
export function parseMemberScript(source: string, query: MemberQuery): MemberItinerary[] {
  const MAX_SOURCE = 4_000_000
  const MAX_CALL = 64_000
  const MAX_CALLS = 2_000
  const MAX_DEPTH = 16
  const MAX_VALUES = 10_000
  const names = new Set(['addOutboundSegmentInfoMap', 'addInboundSegmentInfoMap', 'addRecommendation'])
  const wrappers: Record<string, string> = {
    createOutboundSegmentInfoMap: 'addOutboundSegmentInfoMap',
    createInboundSegmentInfoMap: 'addInboundSegmentInfoMap',
    resetData: 'addRecommendation',
  }
  function fail(detail = '応答形式を認識できませんでした'): never {
    throw new Error(`ANA会員検索の${detail}。空席なしとは判定していません。`)
  }
  function validDate(value: unknown): value is string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
    const date = new Date(`${value}T00:00:00Z`)
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  }
  if (typeof source !== 'string' || !source.trim() || source.length > MAX_SOURCE) fail('応答サイズまたは本文を確認できませんでした')
  if (!query || !/^[A-Z]{3}$/.test(query.origin) || !/^[A-Z]{3}$/.test(query.destination)
    || query.origin === query.destination || !validDate(query.departureDate) || !validDate(query.returnDate)
    || query.returnDate < query.departureDate || !Number.isInteger(query.passengers) || query.passengers < 1 || query.passengers > 9) fail('検索条件が不正です')
  if (query.cabin !== 'economy') fail('指定クラスの予約クラス対応をまだ確認できません')

  const outbound = new Map<number, Map<number, MemberSegment>>()
  const inbound = new Map<number, Map<number, MemberSegment>>()
  const recommendations: unknown[][] = []
  let callCount = 0

  // HTML/XMLの本文や属性に記載された同名文字列は呼出として採用しない。
  const containers = [...source.matchAll(/<(script|eval)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)]
  const scripts = containers.length ? containers.map(match => match[2]) : [source]
  if (!containers.length && /^\s*</.test(source) && !/^\s*<!\[CDATA\[/.test(source)) fail()

  for (const script of scripts) {
    if (![...names].some(name => script.includes(name))) continue
    const text = script.replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '')
    let cursor = 0
    let scopeDepth = 0
    let previous = ';'
    let wrapperCall = ''
    let callStart = -1
    let valueCount = 0

    function bound() {
      if (callStart >= 0 && cursor - callStart > MAX_CALL) fail('1件の応答が上限を超えています')
    }
    function whitespace() {
      while (cursor < text.length) {
        bound()
        if (/\s/.test(text[cursor])) { cursor += 1; continue }
        if (text.startsWith('//', cursor)) {
          const end = text.indexOf('\n', cursor + 2)
          cursor = end < 0 ? text.length : end + 1
          continue
        }
        if (text.startsWith('/*', cursor)) {
          const end = text.indexOf('*/', cursor + 2)
          if (end < 0) fail()
          cursor = end + 2
          continue
        }
        break
      }
      bound()
    }
    function quoted(decode = true): string {
      const quote = text[cursor++]
      let value = ''
      while (cursor < text.length) {
        bound()
        const char = text[cursor++]
        if (char === quote) return value
        if (char === '\n' || char === '\r') fail()
        if (char !== '\\') { value += char; continue }
        const escape = text[cursor++]
        // 対象call外の文字列は、値として読まず引用の終端だけ確認する。
        if (!decode) continue
        const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '\\': '\\', "'": "'", '"': '"', '/': '/' }
        if (Object.hasOwn(escapes, escape)) value += escapes[escape]
        else if (escape === 'u' && /^[\da-fA-F]{4}$/.test(text.slice(cursor, cursor + 4))) {
          value += String.fromCharCode(Number.parseInt(text.slice(cursor, cursor + 4), 16))
          cursor += 4
        } else fail()
      }
      return fail()
    }
    function literal(depth: number): unknown {
      if (depth > MAX_DEPTH || ++valueCount > MAX_VALUES) fail('応答の構造が上限を超えています')
      whitespace()
      const char = text[cursor]
      if (char === "'" || char === '"') return quoted()
      if (char === '[') {
        cursor += 1
        const items: unknown[] = []
        whitespace()
        if (text[cursor] === ']') { cursor += 1; return items }
        while (cursor < text.length) {
          items.push(literal(depth + 1)); whitespace()
          if (text[cursor] === ']') { cursor += 1; return items }
          if (text[cursor++] !== ',') fail()
        }
        return fail()
      }
      if (char === '{') {
        cursor += 1
        // prototypeを書き換えない辞書として扱い、プロパティを実行しない。
        const object = Object.create(null) as Record<string, unknown>
        whitespace()
        if (text[cursor] === '}') { cursor += 1; return object }
        while (cursor < text.length) {
          whitespace()
          let key: string
          if (text[cursor] === "'" || text[cursor] === '"') key = quoted()
          else {
            const match = /^[A-Za-z_$][\w$]*/.exec(text.slice(cursor))
            if (!match) return fail()
            key = match[0]; cursor += key.length
          }
          whitespace()
          if (text[cursor++] !== ':' || Object.hasOwn(object, key)) fail()
          object[key] = literal(depth + 1); whitespace()
          if (text[cursor] === '}') { cursor += 1; return object }
          if (text[cursor++] !== ',') fail()
        }
        return fail()
      }
      const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(cursor))
      if (number) {
        cursor += number[0].length
        const value = Number(number[0])
        if (!Number.isFinite(value)) fail()
        return value
      }
      const keyword = /^(true|false|null)\b/.exec(text.slice(cursor))
      if (!keyword) return fail()
      cursor += keyword[0].length
      return keyword[0] === 'null' ? null : keyword[0] === 'true'
    }
    function argumentsList(): unknown[] {
      cursor += 1
      valueCount = 0
      const args: unknown[] = []
      whitespace()
      if (text[cursor] === ')') { cursor += 1; return args }
      while (cursor < text.length) {
        args.push(literal(0)); whitespace()
        if (text[cursor] === ')') { cursor += 1; bound(); return args }
        if (text[cursor++] !== ',') fail()
      }
      return fail()
    }
    function segment(args: unknown[], map: Map<number, Map<number, MemberSegment>>) {
      if (args.length !== 7 || args.some(arg => typeof arg !== 'string')) fail('区間情報の形式を確認できませんでした')
      const [id, airline, flight, origin, destination, bookingClass, rawDate] = args as string[]
      const index = /^(\d{1,6})_(\d{1,3})$/.exec(id)
      if (!index || !/^[A-Z0-9]{2}$/.test(airline) || !/^\d{1,4}$/.test(flight)
        || !/^[A-Z]{3}$/.test(origin) || !/^[A-Z]{3}$/.test(destination) || !/^[A-Z]$/.test(bookingClass)
        || !/^\d{8}$/.test(rawDate)) fail('区間情報の形式を確認できませんでした')
      const date = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`
      if (!validDate(date)) fail('区間の日付を確認できませんでした')
      const flightId = Number(index[1]), segmentId = Number(index[2])
      const segments = map.get(flightId) ?? new Map<number, MemberSegment>()
      const value: MemberSegment = { flightNumber: `${airline}${flight}`, origin, destination, date, bookingClass }
      const existing = segments.get(segmentId)
      if (existing && JSON.stringify(existing) !== JSON.stringify(value)) fail('重複する区間情報が一致しません')
      segments.set(segmentId, value); map.set(flightId, segments)
    }

    // 観測済み3関数の直下とトップレベルのliteral呼出だけを読む。関数は実行しない。
    while (cursor < text.length) {
      whitespace()
      if (cursor >= text.length) break
      const char = text[cursor]
      if (char === "'" || char === '"') { quoted(false); previous = 'value'; continue }
      if (char === '`') {
        // 未観測のtemplate構文を解析対象へ紛れ込ませない。
        const end = text.indexOf('`', cursor + 1)
        if (end < 0 || /[\\$]/.test(text.slice(cursor + 1, end))) fail()
        cursor = end + 1; previous = 'value'; continue
      }
      if (char === '/') {
        // script内の正規表現literalに見せかけた呼出を除外する。
        cursor += 1
        let inClass = false, closed = false
        while (cursor < text.length) {
          const item = text[cursor++]
          if (item === '\\') { cursor += 1; continue }
          if (item === '[') inClass = true
          if (item === ']') inClass = false
          if (item === '/' && !inClass) { closed = true; break }
          if (item === '\n' || item === '\r') break
        }
        if (!closed) fail()
        previous = 'value'; continue
      }
      const identifier = /^[A-Za-z_$][\w$]*/.exec(text.slice(cursor))
      if (identifier) {
        const name = identifier[0]
        cursor += name.length
        const standalone = (scopeDepth === 0 || scopeDepth === 1 && wrapperCall === name)
          && [';', '}', '{'].includes(previous)
        whitespace()
        if (scopeDepth === 0 && previous === 'function' && Object.hasOwn(wrappers, name)) {
          if (text[cursor++] !== '(') fail('データ関数の形式を確認できませんでした')
          whitespace()
          if (text[cursor++] !== ')') fail('データ関数の形式を確認できませんでした')
          whitespace()
          if (text[cursor++] !== '{') fail('データ関数の形式を確認できませんでした')
          wrapperCall = wrappers[name]
          scopeDepth = 1
          previous = '{'
          continue
        }
        if (names.has(name) && standalone && text[cursor] === '(') {
          if (++callCount > MAX_CALLS) fail('呼出件数が上限を超えています')
          callStart = cursor
          const args = argumentsList()
          callStart = -1
          whitespace()
          if (text[cursor] !== ';' && cursor !== text.length) fail('呼出後の構文を確認できませんでした')
          if (name === 'addOutboundSegmentInfoMap') segment(args, outbound)
          else if (name === 'addInboundSegmentInfoMap') segment(args, inbound)
          else {
            if (args.length !== 24) fail('旅程情報の形式を確認できませんでした')
            recommendations.push(args)
          }
          previous = 'value'
          continue
        }
        previous = name
        continue
      }
      if ('({['.includes(char)) scopeDepth += 1
      if (')}]'.includes(char)) {
        if (scopeDepth <= 0) fail()
        scopeDepth -= 1
        if (scopeDepth === 0) wrapperCall = ''
      }
      previous = char
      cursor += 1
    }
    if (scopeDepth !== 0) fail()
  }
  if (!callCount || !recommendations.length) fail()
  function integer(value: unknown, positive = false): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= (positive ? 1 : 0)
  }
  function airportMatches(actual: string, expected: string): boolean {
    return actual === expected || expected === 'TYO' && ['HND', 'NRT'].includes(actual)
  }
  function matches(segment: MemberSegment, origin: string, destination: string, date: string): boolean {
    return /^NH\d{1,4}$/.test(segment.flightNumber) && segment.bookingClass === 'X'
      && airportMatches(segment.origin, origin) && airportMatches(segment.destination, destination) && segment.date === date
  }
  const results = new Map<string, MemberItinerary>()
  for (const args of recommendations) {
    const [outId, inId, cash, miles, outSeats, inSeats] = [args[1], args[2], args[7], args[11], args[14], args[15]]
    if (!integer(outId) || !integer(inId) || !integer(cash) || !integer(miles, true) || !integer(outSeats) || !integer(inSeats)) fail('料金または席数の形式を確認できませんでした')
    const out = outbound.get(outId), back = inbound.get(inId)
    if (!out || !back) fail('旅程に対応する区間情報が見つかりません')
    // 乗り継ぎを1便へ省略せず、現時点では各方向の単一区間だけを採用する。
    if (out.size !== 1 || back.size !== 1 || !out.has(0) || !back.has(0)) continue
    const outward = out.get(0)!, inward = back.get(0)!
    if (!matches(outward, query.origin, query.destination, query.departureDate)
      || !matches(inward, query.destination, query.origin, query.returnDate)) continue
    const key = [outId, inId, miles, cash, outSeats, inSeats].join('|')
    results.set(key, {
      outbound: [outward], inbound: [inward], outboundSeats: outSeats, inboundSeats: inSeats,
      totalMiles: miles, totalCashJpy: cash,
    })
  }
  if (!results.size) fail('指定条件に対応する旅程を確認できませんでした')
  return [...results.values()]
}
