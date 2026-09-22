import { ROUTES } from '../data/awards'
import { parseMemberScript, type MemberItinerary, type MemberQuery } from './anaMember'

/** 実行時に必要な値は引数・ブラウザー標準API・この関数の内部に限定する。 */
function memberBootstrap(
  appOrigin: string,
  parse: (source: string, query: MemberQuery) => MemberItinerary[],
  routePairs: [string, string][],
  workerMode: boolean,
) {
  const officialOrigin = 'https://aswbe-i.ana.co.jp'
  const channel = 'milefinder-ana-member-v1'
  const actionPath = /^\/rei\w+\/international_asw\/pages\/award\/search\/roundtrip\/award_search_roundtrip_result_owd\.xhtml$/
  type ErrorCode = 'captcha' | 'login' | 'unsupported' | 'failed' | 'busy'
  type BridgeWindow = Window & { __milefinderAnaMemberStop?: () => void }
  const host = window as BridgeWindow
  let peer: Window | null = null
  let virtualDocument: Document | DocumentFragment = document
  let virtualBase = document.baseURI
  let stopped = false
  let invalidated = false
  let current: AbortController | null = null
  let sessionTimer: ReturnType<typeof setTimeout> | undefined

  function fail(code: ErrorCode): never { throw new Error(code) }
  function validDate(value: unknown): value is string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
    const date = new Date(`${value}T00:00:00Z`)
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  }
  function routeMatches(origin: string, destination: string) {
    const match = (requested: string, actual: string) => requested === actual || requested === 'TYO' && ['HND', 'NRT'].includes(actual)
    return routePairs.some(([from, to]) => match(origin, from) && match(destination, to))
  }
  function safeQuery(value: unknown): MemberQuery {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('unsupported')
    const row = value as Record<string, unknown>
    if (Object.keys(row).sort().join(',') !== 'cabin,departureDate,destination,origin,passengers,returnDate'
      || typeof row.origin !== 'string' || !/^[A-Z]{3}$/.test(row.origin)
      || typeof row.destination !== 'string' || !/^[A-Z]{3}$/.test(row.destination)
      || !routeMatches(row.origin, row.destination) || row.cabin !== 'economy'
      || !validDate(row.departureDate) || !validDate(row.returnDate) || row.returnDate < row.departureDate
      || typeof row.passengers !== 'number' || !Number.isInteger(row.passengers) || row.passengers < 1 || row.passengers > 9) fail('unsupported')
    return { origin: row.origin, destination: row.destination, departureDate: row.departureDate, returnDate: row.returnDate, cabin: 'economy', passengers: row.passengers }
  }
  function readQuery(form: HTMLFormElement): MemberQuery {
    const data = new FormData(form)
    const field = (name: string) => {
      const values = data.getAll(name)
      if (values.length !== 1 || typeof values[0] !== 'string') fail('unsupported')
      return values[0] as string
    }
    const date = (name: string) => {
      const value = field(name)
      if (!/^\d{8}$/.test(value)) fail('unsupported')
      return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
    }
    if (field('boardingClass') !== 'CFF1'
      || ['youngAdult:count', 'child:count', 'infant:count'].some(name => field(name) !== '0')) fail('unsupported')
    const passengers = field('adult:count')
    if (!/^[1-9]$/.test(passengers)) fail('unsupported')
    return safeQuery({ origin: field('departureAirportCode:field'), destination: field('arrivalAirportCode:field'), departureDate: date('awardDepartureDate:field'), returnDate: date('awardReturnDate:field'), cabin: 'economy', passengers: Number(passengers) })
  }
  function getForm(doc: ParentNode): HTMLFormElement {
    const form = doc.querySelector('#reSearchForm')
    if (!(form instanceof HTMLFormElement)) fail('unsupported')
    return form
  }
  function actionUrl(form: HTMLFormElement, base: string) {
    const raw = form.getAttribute('action')
    if (!raw) fail('unsupported')
    const url = new URL(raw, base)
    if (url.origin !== officialOrigin || !actionPath.test(url.pathname) || url.username || url.password || url.hash) fail('unsupported')
    return url
  }
  function send(message: Record<string, unknown>) {
    if (!stopped && peer && !peer.closed) peer.postMessage({ channel, connectionId, ...message }, appOrigin)
  }
  function stop() {
    if (stopped) return
    stopped = true
    current?.abort()
    if (sessionTimer !== undefined) clearTimeout(sessionTimer)
    window.removeEventListener('message', receive)
    if (host.__milefinderAnaMemberStop === stop) delete host.__milefinderAnaMemberStop
  }
  function japaneseDate(value: string) {
    const weekday = '日月火水木金土'[new Date(`${value}T00:00:00Z`).getUTCDay()]
    return `${value.slice(0, 4)}年${value.slice(5, 7)}月${value.slice(8, 10)}日(${weekday})`
  }
  function sanitize(rows: MemberItinerary[]): MemberItinerary[] {
    if (!Array.isArray(rows) || !rows.length || rows.length > 2_000) fail('failed')
    const amount = (value: unknown) => {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail('failed')
      return value
    }
    const segments = (items: MemberItinerary['outbound']) => {
      if (!Array.isArray(items) || !items.length || items.length > 8) fail('failed')
      return items.map(item => {
        if (!item || !/^NH\d{1,4}$/.test(item.flightNumber) || !/^[A-Z]{3}$/.test(item.origin)
          || !/^[A-Z]{3}$/.test(item.destination) || !validDate(item.date) || !/^[A-Z]$/.test(item.bookingClass)) fail('failed')
        return { flightNumber: item.flightNumber, origin: item.origin, destination: item.destination, date: item.date, bookingClass: item.bookingClass }
      })
    }
    return rows.map(row => ({ outbound: segments(row.outbound), inbound: segments(row.inbound), outboundSeats: amount(row.outboundSeats), inboundSeats: amount(row.inboundSeats), totalMiles: amount(row.totalMiles), totalCashJpy: amount(row.totalCashJpy) }))
  }

  let initial: MemberQuery
  let airportLabels: { origin: string; destination: string }
  let initialResult: { itineraries: MemberItinerary[]; checkedAt: string } | undefined
  try {
    if (location.origin !== officialOrigin) fail('unsupported')
    const form = getForm(document)
    actionUrl(form, document.baseURI)
    initial = readQuery(form)
    const data = new FormData(form)
    const label = (name: string) => {
      const values = data.getAll(name)
      if (values.length !== 1 || typeof values[0] !== 'string' || !values[0].trim() || values[0].length > 160) fail('unsupported')
      return values[0] as string
    }
    airportLabels = { origin: label('departureAirportCode:field_pctext'), destination: label('arrivalAirportCode:field_pctext') }
  } catch {
    alert('ANA公式の国際線・往復・エコノミーのフライト一覧から接続してください。対応する日本発の路線、成人のみの検索に対応しています。')
    return
  }
  try {
    initialResult = { itineraries: sanitize(parse(document.documentElement.outerHTML, initial)), checkedAt: new Date().toISOString() }
  } catch {
    // 表示済み結果を認識できない場合は、従来どおりフォームで照会する。
  }
  const connectionId = crypto.randomUUID()
  host.__milefinderAnaMemberStop?.()
  peer = window.open(`${appOrigin}/?ana-member=1&ana-bridge=${encodeURIComponent(connectionId)}${workerMode ? '&member-worker=1' : ''}`, 'milefinder-member')
  if (!peer) { alert('MileFinderのウィンドウを開けませんでした。ポップアップを許可して接続し直してください。'); return }
  host.__milefinderAnaMemberStop = stop

  async function search(id: string, raw: unknown) {
    if (current) { send({ type: 'error', id, code: 'busy' }); return }
    if (invalidated) { send({ type: 'error', id, code: 'login' }); return }
    let query: MemberQuery
    try {
      query = safeQuery(raw)
      if (query.origin !== initial.origin || query.destination !== initial.destination) fail('unsupported')
    } catch { send({ type: 'error', id, code: 'unsupported' }); return }

    // 最初の有効な照会だけに使用し、その後に古い表示結果を再利用しない。
    const cached = initialResult
    initialResult = undefined
    if (cached && Object.keys(initial).every(key => initial[key as keyof MemberQuery] === query[key as keyof MemberQuery])) {
      send({ type: 'result', id, query, itineraries: cached.itineraries, checkedAt: cached.checkedAt, source: 'ana-member', partial: true })
      return
    }

    const controller = new AbortController()
    current = controller
    const timeout = setTimeout(() => controller.abort(), 60_000)
    let sent = false
    try {
      const form = getForm(virtualDocument)
      const url = actionUrl(form, virtualBase)
      const echoed = readQuery(form)
      if (echoed.origin !== initial.origin || echoed.destination !== initial.destination) fail('unsupported')
      const data = new FormData(form)
      const submit = form.querySelector<HTMLInputElement>('input[type="submit"][value="検索する"]')
      if (!submit?.name || !/^[-\w:]+$/.test(submit.name)) fail('unsupported')
      const required = ['awardDepartureDate:field_pctext', 'awardReturnDate:field_pctext', 'departureAirportCode:field_pctext', 'arrivalAirportCode:field_pctext']
      if (required.some(name => !data.has(name))) fail('unsupported')
      // 応答HTMLでは空で、通常画面のJavaScriptが補完する公開表示名。固定路線の初期値を使う。
      data.set('departureAirportCode:field_pctext', airportLabels.origin)
      data.set('arrivalAirportCode:field_pctext', airportLabels.destination)
      data.set('awardDepartureDate:field', query.departureDate.replaceAll('-', ''))
      data.set('awardDepartureDate:field_pctext', japaneseDate(query.departureDate))
      data.set('awardReturnDate:field', query.returnDate.replaceAll('-', ''))
      data.set('awardReturnDate:field_pctext', japaneseDate(query.returnDate))
      data.set('boardingClass', 'CFF1')
      data.set('adult:count', String(query.passengers))
      for (const name of ['youngAdult:count', 'child:count', 'infant:count']) data.set(name, '0')
      data.set('hiddenAction', 'AwardRoundTripOwdSearchResultAction')
      data.set('hiddenSearchModeForResearch', 'ROUND_TRIP')
      data.set('hiddenJapanDomesticItinerary', 'false')
      data.set('hiddenDomesticChildAge', 'false')
      data.delete('travelArranger')
      data.delete('comparisonSearchType')
      data.set(submit.name, submit.value)
      const body = new URLSearchParams()
      data.forEach((value, key) => { if (typeof value !== 'string') fail('unsupported'); body.append(key, value) })
      sent = true
      // 観測されたPOST→同一originの結果GETを追従。別originへの遷移はFetch自身が拒否する。
      const response = await fetch(url.href, { method: 'POST', mode: 'same-origin', credentials: 'same-origin', redirect: 'follow', body, signal: controller.signal })
      const responseUrl = new URL(response.url)
      if (!response.ok || responseUrl.origin !== officialOrigin || !actionPath.test(responseUrl.pathname) || !/\btext\/html\b/i.test(response.headers.get('content-type') || '')) fail('failed')
      const text = await response.text()
      if (text.length > 4_000_000) fail('failed')
      // 応答内の画像・iframe・scriptを動かさず、フォームだけを次の照会に保持する。
      const template = document.createElement('template')
      template.innerHTML = text
      const next = template.content
      const headings = [next.querySelector('title')?.textContent || '', ...Array.from(next.querySelectorAll('h1,h2,h3')).map(item => item.textContent || '')].join('\n')
      // 成功画面にも非表示のセッション終了モーダルが常在するため、結果フォームを優先する。
      if (!/検索結果|フライト一覧/.test(headings) || !next.querySelector('#reSearchForm')) {
        if (/画像認証|reCAPTCHA/i.test(headings) || next.querySelector('.g-recaptcha,iframe[src*="recaptcha"]')) fail('captcha')
        if (/ログイン|ログオン|セッション.*(?:終了|切れ|有効期限)/.test(headings)) fail('login')
        fail('failed')
      }
      const nextForm = getForm(next)
      actionUrl(nextForm, response.url)
      const returnedQuery = readQuery(nextForm)
      if (Object.keys(query).some(key => query[key as keyof MemberQuery] !== returnedQuery[key as keyof MemberQuery])) fail('failed')
      const itineraries = sanitize(parse(text, query))
      if (controller.signal.aborted || stopped) fail('failed')
      virtualDocument = next
      virtualBase = response.url
      send({ type: 'result', id, query, itineraries, checkedAt: new Date().toISOString(), source: 'ana-member', partial: true })
    } catch (error) {
      // 送信後の状態が不明なら、古いJSF状態で次の検索を送らない。
      if (sent) invalidated = true
      const code: ErrorCode = error instanceof Error && ['captcha', 'login', 'unsupported'].includes(error.message) ? error.message as ErrorCode : 'failed'
      send({ type: 'error', id, code })
    } finally {
      clearTimeout(timeout)
      if (current === controller) current = null
    }
  }
  function receive(event: MessageEvent) {
    if (stopped || event.origin !== appOrigin || event.source !== peer || !event.data || typeof event.data !== 'object'
      || event.data.channel !== channel || event.data.connectionId !== connectionId) return
    const message = event.data as Record<string, unknown>
    if (message.type === 'disconnect') { stop(); return }
    if (message.type === 'cancel') {
      // UIの初回effectもcancelを送る。未開始の接続は維持する。
      if (current) { invalidated = true; current.abort() }
      return
    }
    if (message.type === 'ready') { if (!invalidated) send({ type: 'connected', query: initial }); return }
    if (message.type !== 'search' || typeof message.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(message.id)) return
    void search(message.id, message.query)
  }
  window.addEventListener('message', receive)
  sessionTimer = setTimeout(stop, 30 * 60_000)
  send({ type: 'connected', query: initial })
}

/** ローカルUIに公開路線情報と自己完結した処理だけを埋め込む。会員情報は含まない。 */
export function buildMemberBookmarklet(appOrigin: string, workerMode = false): string {
  const url = new URL(appOrigin)
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash || appOrigin !== url.origin) throw new Error('会員連携先にはローカルのMileFinderのoriginを指定してください。')
  const pairs = ROUTES.filter(route => route.kind === 'international').map(route => [route.origin, route.destination])
  const script = `void (${memberBootstrap.toString()})(${JSON.stringify(url.origin)},${parseMemberScript.toString()},${JSON.stringify(pairs)},${workerMode === true})`
  return `javascript:${encodeURIComponent(script)}`
}
