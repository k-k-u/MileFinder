import { AIRPORTS } from '../src/data/awards'
import { parseAnaChatPage, type AnaChatOffer } from '../src/lib/anaChat'

export interface AnaAvailabilityQuery {
  origin: string
  destination: string
  dateFrom: string
  dateTo: string
}

export interface AnaAvailabilityResult {
  offers: AnaChatOffer[]
  checkedAt: string
  source: 'ana-public-chat'
  accountScope: 'anonymous'
  partial: boolean
  notes: string[]
}

export interface AnaAvailabilityProgress {
  /** 固定の日本語段階名。外部の回答本文や認証値は含めない。 */
  stage: string
  pages: number
}

const CONSTANTS_URL = 'https://ana-dc.jp/src/constants.js'
const JWT_URL = 'https://api.ana-dc.jp/tokenInitialization'
const KORE_URL = 'https://jp-platform.kore.ai/api/'
const OFFICIAL_PAGE = 'https://www.ana.co.jp/ja/jp/guide/amc/award/'
const MAX_PAGES = 15
const MAX_MESSAGE_BYTES = 200_000
const CONFIG_KEYS = ['jwtUrl', 'koreApiUrl', 'botName', 'botId', 'clientId', 'clientSecret'] as const
type PublicConfig = Record<(typeof CONFIG_KEYS)[number], string>

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

/** 公開設定の文字列リテラルだけを読み取る。JavaScriptは実行しない。 */
export function extractPublicConfig(source: string): PublicConfig {
  if (source.length > 32_000) throw new Error('ANAチャットの公開設定を確認できませんでした。')
  const declaration = /\b(?:const|let|var)\s+BOT_CONFIG\s*=\s*\{([^{}]*)\}/.exec(source)
  if (!declaration) throw new Error('ANAチャットの公開設定形式が変更されています。')
  const result = {} as PublicConfig
  for (const key of CONFIG_KEYS) {
    const expression = new RegExp(`(?:^|,)\\s*(?:"${key}"|${key})\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")\\s*(?=,|$)`, 'g')
    const matches = [...declaration[1].matchAll(expression)]
    if (matches.length !== 1) throw new Error('ANAチャットの公開設定項目を確認できませんでした。')
    let value: unknown
    try { value = JSON.parse(matches[0][1]) } catch { throw new Error('ANAチャットの公開設定が不正です。') }
    if (typeof value !== 'string' || !value || value.length > 4_096) {
      throw new Error('ANAチャットの公開設定が不正です。')
    }
    result[key] = value
  }
  if (result.jwtUrl !== JWT_URL || result.koreApiUrl !== KORE_URL) {
    throw new Error('ANAチャットの接続先が変更されています。')
  }
  return result
}

export function validateSocketUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 16_000) throw new Error('ANAチャットの接続URLが不正です。')
  let url: URL
  try { url = new URL(value) } catch { throw new Error('ANAチャットの接続URLが不正です。') }
  if (url.protocol !== 'wss:' || url.hostname !== 'jp-platform.kore.ai' || url.port
    || url.pathname !== '/rtm/bot' || url.username || url.password || url.hash
    || [...url.searchParams.keys()].some(key => !['sid', 'botId', 'userId'].includes(key))
    || ['sid', 'botId', 'userId'].some(key => url.searchParams.getAll(key).length !== 1 || !url.searchParams.get(key))) {
    throw new Error('ANAチャットの接続先が未確認の形式です。')
  }
  return value
}

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
}

export function validateAnaQuery(query: AnaAvailabilityQuery): void {
  if (!query || typeof query !== 'object'
    || ![query.origin, query.destination, query.dateFrom, query.dateTo].every(value => typeof value === 'string')
    || !validDate(query.dateFrom) || !validDate(query.dateTo)
    || query.dateTo < query.dateFrom
    || Date.parse(query.dateTo) - Date.parse(query.dateFrom) > 6 * 86_400_000) {
    throw new Error('空席照会は有効な日付で連続7日以内を指定してください。')
  }
  const known = (code: string) => code === 'TYO' || AIRPORTS.some(airport => airport.code === code)
  if (!known(query.origin) || !known(query.destination) || query.origin === query.destination) {
    throw new Error('空席照会の空港コードを確認してください。')
  }
  const japanese = (code: string) => code === 'TYO' || AIRPORTS.find(airport => airport.code === code)?.country === '日本'
  if (japanese(query.origin) === japanese(query.destination)) {
    throw new Error('現在の自動照会は日本発着の国際線に対応しています。')
  }
}

function normalize(value: string): string {
  return value.normalize('NFKC').replace(/[\s\u200b]/g, '')
}

function airportInput(code: string): string {
  return code === 'TYO' ? '東京' : AIRPORTS.find(airport => airport.code === code)!.city
}

function airportMatches(label: string, code: string, selectedLabel?: string): boolean {
  const airport = AIRPORTS.find(item => item.code === code)
  const aliases = code === 'TYO' ? ['東京(全て)'] : [airport?.name ?? '']
  if (code === 'HNL') aliases.push('ホノルル(オアフ島)')
  if (selectedLabel) aliases.push(selectedLabel)
  return aliases.some(alias => normalize(label) === normalize(alias))
}

export function selectAirportCandidate(text: string, code: string): { answer: string; label: string } | undefined {
  const candidates = [...text.matchAll(/^\s*(\d+)[.)]\s*([A-Z]{3})\s+([^\r\n]+)\s*$/gm)]
    .filter(match => match[2] === code)
  if (candidates.length !== 1) return undefined
  return { answer: candidates[0][1], label: candidates[0][3].trim() }
}

export function matchesFinalConfirmation(
  text: string,
  query: AnaAvailabilityQuery,
  labels: { origin?: string; destination?: string } = {},
): boolean {
  const date = /^\s*出発日[：:]\s*(\d{4})\/(\d{1,2})\/(\d{1,2})\s*$/m.exec(text)
  const origin = /^\s*出発地[：:]\s*([^\r\n]+)\s*$/m.exec(text)
  const destination = /^\s*到着地[：:]\s*([^\r\n]+)\s*$/m.exec(text)
  return !!date && !!origin && !!destination
    && `${date[1]}-${date[2].padStart(2, '0')}-${date[3].padStart(2, '0')}` === query.dateFrom
    && airportMatches(origin[1], query.origin, labels.origin)
    && airportMatches(destination[1], query.destination, labels.destination)
    && text.includes('ご入力された内容はこちらでよろしいでしょうか')
}

/** 観測済み bot_response の表示本文だけを採用する。セッション等は取得しない。 */
export function extractBotText(value: unknown): string {
  const frame = record(value)
  if (frame?.type !== 'bot_response' || !Array.isArray(frame.message)) return ''
  return frame.message.map(item => {
    const message = record(item)
    const component = record(message?.component)
    const payload = record(component?.payload)
    const content = record(message?.cInfo)
    const text = payload?.text ?? content?.body
    return typeof text === 'string' ? text : ''
  }).filter(Boolean).join('\n')
}

/** 次ページが指定期間の翌日になった場合も、未解析の回答と区別する。 */
export function parseAnaAvailabilityPage(text: string, query: AnaAvailabilityQuery) {
  const page = parseAnaChatPage(text, {
    dateFrom: query.dateFrom,
    dateTo: new Date(Date.parse(query.dateTo) + 86_400_000).toISOString().slice(0, 10),
  })
  return {
    recognized: page.recognized,
    hasMore: page.hasMore,
    beyondRange: page.offers.some(offer => offer.date > query.dateTo),
    offers: page.offers.filter(offer => offer.date >= query.dateFrom && offer.date <= query.dateTo),
  }
}

/** 後続ページの障害でも既得回答を残す。明示的な中断時は結果を返さない。 */
export function finalizeAnaAvailability(
  offers: AnaChatOffer[], notes: string[], failure?: unknown, userSignal?: AbortSignal,
): AnaAvailabilityResult {
  userSignal?.throwIfAborted()
  if (!offers.length) {
    if (failure !== undefined) throw failure
    throw new Error('指定期間の空席回答を取得できませんでした。空席なしとは判定していません。')
  }
  return {
    offers, checkedAt: new Date().toISOString(), source: 'ana-public-chat', accountScope: 'anonymous', partial: true,
    notes: [
      ...notes,
      ...(failure !== undefined ? ['後続ページの回答を取得・解析できなかったため、取得済みの回答のみ表示しています。未取得部分を空席なしとは判定していません。']
        : notes.length === 2 ? ['取得ページ数または会話回数の上限に達したため、検索結果の一部です。'] : []),
    ],
  }
}

type Stage = 'login' | 'method' | 'direct' | 'airlines' | 'date' | 'date-confirm'
  | 'origin' | 'destination' | 'cabin' | 'confirm' | 'results'

const STAGE_LABELS: Record<Stage, string> = {
  login: 'ログイン確認', method: '検索方法の選択', direct: '直行便の指定', airlines: '特典航空券の種類',
  date: '出発日の入力', 'date-confirm': '出発日の確認', origin: '出発地の入力', destination: '到着地の入力',
  cabin: '搭乗クラスの選択', confirm: '検索条件の最終確認', results: '空席結果の取得',
}

export class AnaConversation {
  stage: Stage = 'login'
  private labels: { origin?: string; destination?: string } = {}
  private candidateAnswers = 0
  readonly query: AnaAvailabilityQuery
  constructor(query: AnaAvailabilityQuery) { this.query = query }

  /** 未知の質問には返答しない。条件の不一致は検索前に中断する。 */
  answer(text: string): string | undefined {
    if (this.stage === 'results') return undefined
    if (/^\s*\d+[.)]\s*[A-Z]{3}\s+/m.test(text)) {
      if (++this.candidateAnswers > 4 || !['destination', 'cabin', 'confirm'].includes(this.stage)) {
        throw new Error('ANAチャットの空港候補を特定できませんでした。')
      }
      // 出発空港の候補が到着地入力の後に届く実応答がある。直前の入力から推測しない。
      const origin = selectAirportCandidate(text, this.query.origin)
      const destination = selectAirportCandidate(text, this.query.destination)
      if (!!origin === !!destination) throw new Error('指定した空港をANAチャットの候補から一意に選べません。')
      const side = origin ? 'origin' : 'destination'
      const selected = origin ?? destination!
      this.labels[side] = selected.label
      return selected.answer
    }
    switch (this.stage) {
      case 'login':
        if (/ログイン状況を確認|ログイン.*確認しますか/.test(text)) { this.stage = 'method'; return 'いいえ' }
        break
      case 'method':
        if (/行き先・日付から検索する/.test(text) && /1[.．、)）]|１/.test(text)) { this.stage = 'direct'; return '1' }
        break
      case 'direct':
        if (/直行便/.test(text) && /乗り継ぎ|乗継|経由/.test(text)) { this.stage = 'airlines'; return '1' }
        break
      case 'airlines':
        if (/ANA/.test(text) && /スターアライアンス|Star Alliance/.test(text)) { this.stage = 'date'; return '1' }
        break
      case 'date':
        if (/出発日|搭乗日/.test(text) && /入力|教えて|指定|選択/.test(text)) {
          this.stage = 'date-confirm'
          const [year, month, day] = this.query.dateFrom.split('-').map(Number)
          return `${year}年${month}月${day}日`
        }
        break
      case 'date-confirm':
        if (/はい/.test(text) && /よろしい|間違い/.test(text)) {
          const [year, month, day] = this.query.dateFrom.split('-').map(Number)
          const date = new RegExp(`${year}(?:年|/)0?${month}(?:月|/)0?${day}(?:日|\\b)`)
          if (!date.test(text)) throw new Error('ANAチャットが確認した出発日が指定日と一致しません。')
          this.stage = 'origin'; return 'はい'
        }
        break
      case 'origin':
        if (/出発地|出発空港/.test(text) && /入力|教えて|選択/.test(text)) {
          this.stage = 'destination'; return airportInput(this.query.origin)
        }
        break
      case 'destination':
        if (/到着地|到着空港|目的地/.test(text) && /入力|教えて|選択/.test(text)) {
          this.stage = 'cabin'; return airportInput(this.query.destination)
        }
        break
      case 'cabin':
        if (/クラス/.test(text) && /全て|すべて/.test(text)) { this.stage = 'confirm'; return '全て' }
        break
      case 'confirm':
        if (/出発日[：:]/.test(text) && /到着地[：:]/.test(text)) {
          if (!matchesFinalConfirmation(text, this.query, this.labels)) {
            throw new Error('ANAチャットの最終確認が指定条件と一致しないため照会を中断しました。')
          }
          this.stage = 'results'; return 'はい'
        }
        break
    }
    return undefined
  }
}

async function fetchChecked(url: string, init: RequestInit, signal: AbortSignal): Promise<string> {
  if (![CONSTANTS_URL, JWT_URL, `${KORE_URL}oAuth/token/jwtgrant`, `${KORE_URL}rtm/start`].includes(url)) {
    throw new Error('許可されていないANAチャット接続先です。')
  }
  const stage = url === CONSTANTS_URL ? '公開設定' : url === JWT_URL ? '初期JWT認証'
    : url.endsWith('/jwtgrant') ? 'Kore認証' : 'RTM接続準備'
  let response: Response
  let text: string
  try {
    const headers = new Headers(init.headers)
    headers.set('Referer', 'https://www.ana.co.jp/')
    headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36')
    response = await fetch(url, { ...init, headers, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), redirect: 'error' })
    text = await response.text()
  } catch {
    throw new Error(`ANAチャットの${stage}で通信できませんでした。`)
  }
  if (!response.ok) throw new Error(`ANAチャットの${stage}に失敗しました（HTTP ${response.status}）。`)
  if (text.length > MAX_MESSAGE_BYTES) throw new Error('ANAチャットの応答サイズが想定を超えています。')
  return text
}

function parseJsonResponse(text: string): Record<string, unknown> {
  try {
    const parsed = record(JSON.parse(text))
    if (parsed) return parsed
  } catch { /* 外部の本文や認証値をエラーメッセージに含めない。 */ }
  throw new Error('ANAチャットのJSON応答を読み取れませんでした。')
}

async function postJson(url: string, body: unknown, signal: AbortSignal, bearer?: string): Promise<Record<string, unknown>> {
  const text = await fetchChecked(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  }, signal)
  return parseJsonResponse(text)
}

export class ChatSocket {
  private readonly socket: WebSocket
  private readonly messages: string[] = []
  private notify: (() => void) | undefined
  private failure: Error | undefined
  private sessionStarted = false
  private readonly readyWaiters = new Set<() => void>()
  private id = 0
  private readonly signal: AbortSignal
  private readonly onAbort: () => void
  private keepAliveTimer: ReturnType<typeof setInterval> | undefined
  private keepAliveInfo: Record<string, unknown> | undefined
  private pingId = 0
  readonly opened: Promise<void>

  constructor(url: string, signal: AbortSignal) {
    this.signal = signal
    this.socket = new WebSocket(validateSocketUrl(url))
    this.onAbort = () => { this.fail('ANAチャットの照会を中断しました。'); this.close() }
    this.opened = new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('ANAチャットへの接続が時間切れになりました。')), 30_000)
      const onOpen = () => finish()
      const onFailure = () => finish(new Error('ANAチャットへの接続に失敗しました。'))
      const finish = (error?: Error) => {
        clearTimeout(timer)
        this.socket.removeEventListener('open', onOpen)
        this.socket.removeEventListener('error', onFailure)
        this.socket.removeEventListener('close', onFailure)
        signal.removeEventListener('abort', onFailure)
        if (error) reject(error); else resolve()
      }
      this.socket.addEventListener('open', onOpen, { once: true })
      this.socket.addEventListener('error', onFailure, { once: true })
      this.socket.addEventListener('close', onFailure, { once: true })
      signal.addEventListener('abort', onFailure, { once: true })
    })
    this.socket.addEventListener('message', event => {
      if (typeof event.data !== 'string' || event.data.length > MAX_MESSAGE_BYTES) return
      try {
        const frame: unknown = JSON.parse(event.data)
        const object = record(frame)
        if (object?.type === 'error' || object?.type === 'bot_error' || (Array.isArray(object?.errors) && object.errors.length)) {
          this.fail('ANAチャットからエラー応答が返されました。空席なしとは判定していません。')
          return
        }
        if (object?.type === 'Session_Start') {
          this.sessionStarted = true
          for (const ready of this.readyWaiters) ready()
          return
        }
        const text = extractBotText(frame)
        if (text.split('\n').some(line => line.trim() === 'An error occurred, please try again')) {
          this.fail('ANAチャットが一時エラーを回答しました。空席なしとは判定していません。')
          return
        }
        if (text) { this.messages.push(text); this.notify?.() }
      } catch { this.fail('ANAチャットの応答形式を確認できませんでした。') }
    })
    this.socket.addEventListener('error', () => this.fail('ANAチャットとの接続でエラーが発生しました。'))
    this.socket.addEventListener('close', () => {
      this.stopKeepAlive()
      this.fail('ANAチャットとの接続が終了しました。')
    })
    signal.addEventListener('abort', this.onAbort, { once: true })
  }

  private fail(message: string): void {
    this.failure = new Error(message)
    this.notify?.()
    for (const ready of this.readyWaiters) ready()
  }
  close(): void {
    this.stopKeepAlive()
    this.signal.removeEventListener('abort', this.onAbort)
    this.fail('ANAチャットとの接続が終了しました。')
    this.socket.close()
  }

  /** 開始通知はopen直後とは限らない。受信済みフラグを参照し、本文キューは消費しない。 */
  async waitUntilReady(): Promise<void> {
    this.signal.throwIfAborted()
    if (this.failure) throw this.failure
    if (this.sessionStarted) return
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.readyWaiters.delete(check)
        if (error) reject(error); else resolve()
      }
      const check = () => {
        if (this.signal.aborted) finish(new Error('ANAチャットの開始通知待ちを中断しました。'))
        else if (this.failure) finish(this.failure)
        else if (this.sessionStarted) finish()
      }
      const timer = setTimeout(() => finish(new Error('ANAチャットの開始通知を確認できませんでした（待機段階：チャット開始、30秒で時間切れ）。')), 30_000)
      this.readyWaiters.add(check)
      check()
    })
  }

  startKeepAlive(botInfo: Record<string, unknown>): void {
    this.keepAliveInfo = botInfo
    this.resetKeepAlive()
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer !== undefined) clearInterval(this.keepAliveTimer)
    this.keepAliveTimer = undefined
  }

  private resetKeepAlive(): void {
    this.stopKeepAlive()
    if (!this.keepAliveInfo || this.signal.aborted) return
    this.keepAliveTimer = setInterval(() => {
      if (this.socket.readyState !== WebSocket.OPEN || this.signal.aborted) return
      try {
        this.socket.send(JSON.stringify({
          type: 'ping', agentDesktopMeta: { pagesVisited: [] }, resourceid: '/bot.message',
          botInfo: this.keepAliveInfo, client: 'sdk', meta: { timezone: 'Asia/Tokyo', locale: 'ja' },
          id: ++this.pingId,
        }))
      } catch {
        this.stopKeepAlive()
        this.fail('ANAチャットの接続維持に失敗しました。')
      }
    }, 30_000)
  }

  send(body: string, botInfo: Record<string, unknown>): void {
    this.signal.throwIfAborted()
    this.id = Math.max(Date.now(), this.id + 1)
    this.socket.send(JSON.stringify({
      clientMessageId: this.id, resourceid: '/bot.message', message: { body },
      agentDesktopMeta: { pagesVisited: [] }, botInfo, client: 'sdk',
      meta: { timezone: 'Asia/Tokyo', locale: 'ja' }, id: this.id,
    }))
    this.resetKeepAlive()
  }

  async next(timeout = 120_000, stage: Stage = 'results', pages = 0): Promise<string> {
    const end = Date.now() + timeout
    while (!this.messages.length) {
      this.signal.throwIfAborted()
      if (this.failure) throw this.failure
      const remaining = end - Date.now()
      if (remaining <= 0) {
        throw new Error(`ANAチャットの回答を確認できませんでした（待機段階：${STAGE_LABELS[stage]}、取得済み：${pages}ページ）。空席なしを意味するものではありません。`)
      }
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { this.notify = undefined; resolve() }, remaining)
        this.notify = () => { clearTimeout(timer); this.notify = undefined; resolve() }
      })
    }
    // 1つの回答が複数 bot_response に分かれるため、直後の表示本文もまとめる。
    await new Promise<void>(resolve => setTimeout(resolve, 600))
    return this.messages.splice(0).join('\n')
  }
}

export async function searchAnaAvailability(
  query: AnaAvailabilityQuery,
  signal?: AbortSignal,
  onProgress?: (progress: AnaAvailabilityProgress) => void,
): Promise<AnaAvailabilityResult> {
  validateAnaQuery(query)
  const progress = (stage: string, pages = 0) => {
    // 診断の受け取り側で例外が起きても、公式チャットの会話には影響させない。
    try { onProgress?.({ stage, pages }) } catch { /* 診断callbackは任意。 */ }
  }
  const combined = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(9 * 60_000)])
  progress('公開設定の取得')
  const config = extractPublicConfig(await fetchChecked(CONSTANTS_URL, {}, combined))
  const identity = crypto.randomUUID()
  const botInfo: Record<string, unknown> = {
    chatBot: config.botName, taskBotId: config.botId,
    customData: { token: null, aswurl: OFFICIAL_PAGE, browser_type: 'Chrome' },
    uiVersion: 'v3',
  }
  progress('初期JWT認証')
  const initial = parseJsonResponse(await fetchChecked(config.jwtUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: new URLSearchParams({ clientId: config.clientId, clientSecret: config.clientSecret, identity, aud: '', isAnonymous: 'false' }),
  }, combined))
  if (typeof initial?.jwt !== 'string') throw new Error('ANAチャットの初期認証に失敗しました。')
  progress('Kore認証')
  const granted = await postJson(`${config.koreApiUrl}oAuth/token/jwtgrant`, { assertion: initial.jwt, botInfo, token: {} }, combined)
  const accessToken = record(granted.authorization)?.accessToken
  if (typeof accessToken !== 'string') throw new Error('ANAチャットの接続認証に失敗しました。')
  progress('RTM接続準備')
  const rtm = await postJson(`${config.koreApiUrl}rtm/start`, { botInfo, language: 'en', token: {} }, combined, accessToken)
  progress('WebSocket接続')
  const chat = new ChatSocket(validateSocketUrl(rtm.url), combined)
  const conversation = new AnaConversation(query)
  const offers = new Map<string, AnaChatOffer>()
  let pages = 0
  let buffer = ''
  let failure: unknown
  const notes = [
    'ANA公式チャットの未ログイン時の回答です。会員ステイタスに応じた優先枠は反映されません。',
    '回答後に空席が変わることがあります。予約可否と必要マイルはANA公式予約画面で確認してください。',
  ]
  try {
    await chat.opened
    progress('チャットの開始通知待ち')
    await chat.waitUntilReady()
    chat.startKeepAlive(botInfo)
    chat.send('国際線特典航空券の空席案内', botInfo)
    for (let turn = 0; turn < 65; turn += 1) {
      progress(STAGE_LABELS[conversation.stage], pages)
      buffer += `\n${await chat.next(120_000, conversation.stage, pages)}`
      if (buffer.length > MAX_MESSAGE_BYTES) throw new Error('ANAチャットの回答を特定できませんでした。')
      if (conversation.stage !== 'results') {
        const answer = conversation.answer(buffer)
        if (!answer) continue
        buffer = ''
        chat.send(answer, botInfo)
        continue
      }
      const page = parseAnaAvailabilityPage(buffer, query)
      if (!page.recognized) {
        if (page.hasMore || /該当.*ありません|空席.*ありません/.test(buffer)) {
          throw new Error('ANAチャットの検索回答を解析できませんでした。空席なしとは判定していません。')
        }
        continue
      }
      for (const offer of page.offers) {
        const key = `${offer.flightNumber}|${offer.date}|${offer.time}|${offer.cabin}`
        offers.set(key, offer)
      }
      pages += 1
      progress(STAGE_LABELS.results, pages)
      if (!page.hasMore) {
        notes.push('続きの案内を確認できなかったため、取得済みの回答を表示しています。検索の完了や全便の網羅を保証するものではありません。')
        break
      }
      if (page.beyondRange) {
        notes.push('対象期間より後の日付が回答に現れた時点で取得を終了しました。期間内の全便を網羅する保証はありません。')
        break
      }
      if (pages >= MAX_PAGES) break
      buffer = ''
      chat.send('はい', botInfo)
    }
  } catch (error) {
    failure = error
  } finally { chat.close() }
  return finalizeAnaAvailability([...offers.values()], notes, failure, signal)
}
