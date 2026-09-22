import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AnaConversation, ChatSocket, extractBotText, extractPublicConfig, finalizeAnaAvailability, matchesFinalConfirmation,
  parseAnaAvailabilityPage, searchAnaAvailability, selectAirportCandidate, validateAnaQuery, validateSocketUrl,
  type AnaAvailabilityProgress,
} from './anaProvider'

const query = { origin: 'TYO', destination: 'HNL', dateFrom: '2026-10-01', dateTo: '2026-10-07' }
const confirmation = '出発日：2026/10/01\n出発地：東京(全て)\n到着地：ホノルル(オアフ島)\n搭乗クラス：ファーストクラス、ビジネスクラス、プレミアムエコノミークラス、エコノミークラス\nご入力された内容はこちらでよろしいでしょうか？\n「はい」または「いいえ」を入力してください。'
const configFields = {
  jwtUrl: 'https://api.ana-dc.jp/tokenInitialization', koreApiUrl: 'https://jp-platform.kore.ai/api/',
  botName: 'test-bot', botId: 'test-bot-id', clientId: 'test-client', clientSecret: 'test-only-placeholder',
}
const configSource = `export const BOT_CONFIG=${JSON.stringify(configFields)};`

function pageText(date: string): string {
  return `1) 直行便\nNH186便\n東京(羽田) - ホノルル(オアフ島)\nエコノミークラス\n${date} 21:55発 2席\n######\n検索結果をさらに表示いたしますか？\n「はい」または「いいえ」を入力してください。`
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

function mockInitialConnection(reply?: string, autoReady = true) {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(configSource))
    .mockResolvedValueOnce(Response.json({ jwt: 'test-only-jwt' }))
    .mockResolvedValueOnce(Response.json({ authorization: { accessToken: 'test-only-access' } }))
    .mockResolvedValueOnce(Response.json({ url: 'wss://jp-platform.kore.ai/rtm/bot?sid=test&botId=test&userId=test' }))
  vi.stubGlobal('fetch', fetchMock)
  const sockets: FakeSocket[] = []
  class FakeSocket extends EventTarget {
    static OPEN = 1
    readyState = 1
    sent: Record<string, unknown>[] = []
    constructor() {
      super()
      sockets.push(this)
      queueMicrotask(() => {
        this.dispatchEvent(new Event('open'))
        if (autoReady) this.emit({ type: 'Session_Start' })
      })
    }
    emit(frame: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) })) }
    send(value: string) {
      const frame = JSON.parse(value)
      this.sent.push(frame)
      if (reply && frame.message?.body) queueMicrotask(() => this.emit({
        type: 'bot_response', message: [{ component: { payload: { text: reply } } }],
      }))
    }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')) }
  }
  vi.stubGlobal('WebSocket', FakeSocket)
  return { fetchMock, sockets }
}

describe('チャット開始通知の待機', () => {
  it('Session_Startが届くまでは初回ユーザーメッセージを送信しない', async () => {
    vi.useFakeTimers()
    const { sockets } = mockInitialConnection('An error occurred, please try again', false)
    const progress: AnaAvailabilityProgress[] = []
    const completed = searchAnaAvailability(query, undefined, item => progress.push(item))
      .then(() => undefined, (error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    expect(sockets).toHaveLength(1)
    expect(progress.at(-1)).toEqual({ stage: 'チャットの開始通知待ち', pages: 0 })
    expect(sockets[0].sent).toEqual([])
    sockets[0].emit({ type: 'Bot_Active' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(sockets[0].sent).toEqual([])
    sockets[0].emit({ type: 'Session_Start' })
    await vi.advanceTimersByTimeAsync(0)
    expect(sockets[0].sent).toHaveLength(1)
    expect(sockets[0].sent[0].message).toEqual({ body: '国際線特典航空券の空席案内' })
    expect(await completed).toBeInstanceOf(Error)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('待機呼出より早い開始通知を保持し、先行する本文キューも消費しない', async () => {
    vi.useFakeTimers()
    const { sockets } = mockInitialConnection()
    const chat = new ChatSocket('wss://jp-platform.kore.ai/rtm/bot?sid=test&botId=test&userId=test', new AbortController().signal)
    await vi.advanceTimersByTimeAsync(0)
    await chat.opened
    sockets[0].emit({ type: 'bot_response', message: [{ cInfo: { body: '先行する本文' } }] })
    await chat.waitUntilReady()
    const text = chat.next()
    await vi.advanceTimersByTimeAsync(600)
    expect(await text).toBe('先行する本文')
    chat.close()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('開始待機中のabort・close・error・30秒timeoutを処理してタイマーを残さない', async () => {
    vi.useFakeTimers()
    for (const action of ['abort', 'close', 'error', 'timeout'] as const) {
      const { sockets } = mockInitialConnection(undefined, false)
      const controller = new AbortController()
      const chat = new ChatSocket('wss://jp-platform.kore.ai/rtm/bot?sid=test&botId=test&userId=test', controller.signal)
      await vi.advanceTimersByTimeAsync(0)
      await chat.opened
      const completed = chat.waitUntilReady().then(() => undefined, (error: unknown) => error)
      if (action === 'abort') controller.abort()
      else if (action === 'close') chat.close()
      else if (action === 'error') sockets[0].emit({ type: 'error', details: 'private-value' })
      else await vi.advanceTimersByTimeAsync(30_000)
      const error = await completed
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toMatch(/^ANAチャット/)
      expect((error as Error).message).not.toContain('private-value')
      if (action === 'timeout') expect((error as Error).message).toContain('30秒で時間切れ')
      chat.close()
      expect(vi.getTimerCount()).toBe(0)
    }
  })
})

describe('外部通信なしの段階診断', () => {
  it('各HTTP段階でリダイレクトを追従せず3xxを拒否する', async () => {
    const stages = ['公開設定', '初期JWT認証', 'Kore認証', 'RTM接続準備']
    for (let index = 0; index < stages.length; index++) {
      const { fetchMock, sockets } = mockInitialConnection()
      fetchMock.mockReset()
      const replies = [
        new Response(configSource),
        Response.json({ jwt: 'test-only-jwt' }),
        Response.json({ authorization: { accessToken: 'test-only-access' } }),
      ]
      for (const reply of replies.slice(0, index)) fetchMock.mockResolvedValueOnce(reply)
      const status = [301, 302, 307, 308][index]
      fetchMock.mockResolvedValueOnce(new Response('external-response-not-used', {
        status, headers: { Location: 'https://unapproved.example/redirect' },
      }))
      await expect(searchAnaAvailability(query))
        .rejects.toThrow(`ANAチャットの${stages[index]}に失敗しました（HTTP ${status}）。`)
      expect(fetchMock).toHaveBeenCalledTimes(index + 1)
      expect(fetchMock.mock.calls.every(([, init]) => init.redirect === 'manual')).toBe(true)
      expect(sockets).toHaveLength(0)
    }
  })

  it('初回回答timeoutに待機段階を付け、進捗には固定段階名とページ数だけを含める', async () => {
    vi.useFakeTimers()
    const { fetchMock } = mockInitialConnection()
    const progress: AnaAvailabilityProgress[] = []
    const completed = searchAnaAvailability(query, undefined, item => progress.push(item))
      .then(() => undefined, (error: unknown) => error)
    await vi.advanceTimersByTimeAsync(120_100)
    const error = await completed
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('待機段階：ログイン確認、取得済み：0ページ')
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(progress.map(item => item.stage)).toEqual([
      '公開設定の取得', '初期JWT認証', 'Kore認証', 'RTM接続準備', 'WebSocket接続', 'チャットの開始通知待ち', 'ログイン確認',
    ])
    for (const item of progress) {
      expect(Object.keys(item)).toEqual(['stage', 'pages'])
      expect(item.pages).toBe(0)
    }
    expect(JSON.stringify(progress)).not.toMatch(/test-only|sid|accessToken|clientSecret/)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('既知のエラー本文はtimeoutを待たず固定エラーへ変換し、診断callbackの失敗に影響されない', async () => {
    mockInitialConnection('An error occurred, please try again')
    const progress = vi.fn(() => { throw new Error('diagnostic-only-private-value') })
    await expect(searchAnaAvailability(query, undefined, progress))
      .rejects.toThrow('ANAチャットが一時エラーを回答しました。空席なしとは判定していません。')
    expect(progress).toHaveBeenCalledWith({ stage: 'ログイン確認', pages: 0 })
  })
})

describe('ページ境界と取得途中の障害', () => {
  it('7日目の回答を保持し、8日目を期間外として認識して返却対象から除く', () => {
    const last = parseAnaAvailabilityPage(pageText('10/07'), query)
    expect(last.offers).toHaveLength(1)
    expect(last.offers[0].date).toBe('2026-10-07')
    expect(last.beyondRange).toBe(false)
    const next = parseAnaAvailabilityPage(pageText('10/08'), query)
    expect(next).toMatchObject({ recognized: true, hasMore: true, beyondRange: true, offers: [] })
    const result = finalizeAnaAvailability([...last.offers, ...next.offers], ['期間外ページで終了'])
    expect(result.offers.map(offer => offer.date)).toEqual(['2026-10-07'])
    expect(result.partial).toBe(true)
  })

  it('年越しの7日目とその翌日も正しい年に解決する', () => {
    const yearBoundary = { ...query, dateFrom: '2026-12-25', dateTo: '2026-12-31' }
    expect(parseAnaAvailabilityPage(pageText('12/31'), yearBoundary).offers[0].date).toBe('2026-12-31')
    expect(parseAnaAvailabilityPage(pageText('01/01'), yearBoundary))
      .toMatchObject({ recognized: true, beyondRange: true, offers: [] })
  })

  it('後続の未知回答・timeoutでは取得済み席数を残し、障害の生情報は返さない', () => {
    const offers = parseAnaAvailabilityPage(pageText('10/01'), query).offers
    expect(parseAnaAvailabilityPage('未知の回答形式です。検索結果をさらに表示いたしますか？', query).recognized).toBe(false)
    for (const error of [new Error('private-response-value'), new DOMException('timeout-private-value', 'TimeoutError')]) {
      const result = finalizeAnaAvailability(offers, [], error)
      expect(result.offers[0].seats).toBe(2)
      expect(result.partial).toBe(true)
      expect(result.notes.join('')).toContain('後続ページ')
      expect(result.notes.join('')).not.toContain('private')
      expect(() => finalizeAnaAvailability([], [], error)).toThrow(error)
    }
    expect(() => finalizeAnaAvailability([], [])).toThrow(/取得できません/)
  })

  it('ユーザーのabort時は既得結果があっても返却しない', () => {
    const abort = new AbortController()
    const offers = parseAnaAvailabilityPage(pageText('10/01'), query).offers
    abort.abort()
    expect(() => finalizeAnaAvailability(offers, [], undefined, abort.signal)).toThrow()
    expect(() => finalizeAnaAvailability(offers, [], new Error('late failure'), abort.signal)).toThrow()
  })
})

describe('観測済み接続維持フレーム', () => {
  it('30秒ごとのpingを送信し、closeとabortでタイマーを終了する', async () => {
    vi.useFakeTimers()
    class FakeSocket extends EventTarget {
      static OPEN = 1
      static instances: FakeSocket[] = []
      readyState = 1
      sent: string[] = []
      constructor() { super(); FakeSocket.instances.push(this) }
      send(value: string) { this.sent.push(value) }
      close() { this.readyState = 3; this.dispatchEvent(new Event('close')) }
    }
    vi.stubGlobal('WebSocket', FakeSocket)
    for (const action of ['close', 'abort'] as const) {
      const controller = new AbortController()
      const chat = new ChatSocket('wss://jp-platform.kore.ai/rtm/bot?sid=test&botId=test&userId=test', controller.signal)
      const socket = FakeSocket.instances.at(-1)!
      socket.dispatchEvent(new Event('open'))
      await chat.opened
      const botInfo = { chatBot: 'test-only-bot' }
      chat.startKeepAlive(botInfo)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(socket.sent.map(text => JSON.parse(text))).toEqual([1, 2].map(id => ({
        type: 'ping', agentDesktopMeta: { pagesVisited: [] }, resourceid: '/bot.message',
        botInfo, client: 'sdk', meta: { timezone: 'Asia/Tokyo', locale: 'ja' }, id,
      })))
      if (action === 'close') chat.close(); else controller.abort()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(socket.sent).toHaveLength(2)
      expect(vi.getTimerCount()).toBe(0)
    }
  })
})

describe('ANA公開設定と接続先', () => {
  it('必要な文字列だけを抽出し、コードを実行しない', () => {
    expect(extractPublicConfig(`${configSource}\nthrow new Error('この文を実行してはいけません');`)).toEqual(configFields)
    expect(() => extractPublicConfig('const BOT_CONFIG = runUnknownCode();')).toThrow()
    expect(() => extractPublicConfig(configSource.replace('"test-client"', 'readSecret()'))).toThrow()
    expect(() => extractPublicConfig(configSource.replace('https://api.ana-dc.jp/tokenInitialization', 'https://evil.example/tokenInitialization'))).toThrow()
    expect(() => extractPublicConfig(configSource.replace('"clientId":', '"clientId":"duplicate","clientId":'))).toThrow()
    expect(() => extractPublicConfig('x'.repeat(32_001))).toThrow()
  })

  it('実観測WebSocket URLのhost/path/queryキーだけを許可する', () => {
    const valid = 'wss://jp-platform.kore.ai/rtm/bot?sid=test&botId=test&userId=test'
    expect(validateSocketUrl(valid)).toBe(valid)
    for (const invalid of [
      valid.replace('wss:', 'ws:'), valid.replace('jp-platform.kore.ai', 'jp-platform.kore.ai.evil.example'),
      valid.replace('/rtm/bot', '/other'), `${valid}&callback=https://evil.example`, `${valid}&sid=duplicate`,
      `${valid}#fragment`, valid.replace('jp-platform', 'user:password@jp-platform'),
      valid.replace('jp-platform.kore.ai', 'jp-platform.kore.ai:444'), valid.replace('sid=test&', ''),
    ]) expect(() => validateSocketUrl(invalid)).toThrow()
  })
})

describe('ANA照会条件', () => {
  it('1〜7日と年またぎを許可し、不正日付・未知空港・国内線を拒否する', () => {
    expect(() => validateAnaQuery(query)).not.toThrow()
    expect(() => validateAnaQuery({ ...query, dateTo: query.dateFrom })).not.toThrow()
    expect(() => validateAnaQuery({ ...query, dateFrom: '2026-12-29', dateTo: '2027-01-04' })).not.toThrow()
    for (const invalid of [
      { dateTo: '2026-10-08' }, { dateFrom: '2026-02-30' }, { dateTo: '2026-09-30' },
      { origin: 'XXX' }, { origin: 'HNL' }, { destination: 'CTS' },
    ]) expect(() => validateAnaQuery({ ...query, ...invalid })).toThrow()
  })

  it('最終確認で出発日・出発空港・到着空港すべての一致を要求する', () => {
    expect(matchesFinalConfirmation(confirmation, query)).toBe(true)
    for (const invalid of [
      confirmation.replace('2026/10/01', '2026/10/02'), confirmation.replace('東京(全て)', '東京(羽田)'),
      confirmation.replace('ホノルル(オアフ島)', 'ロサンゼルス'),
    ]) expect(matchesFinalConfirmation(invalid, query)).toBe(false)
    expect(matchesFinalConfirmation(confirmation, { ...query, origin: 'HND' })).toBe(false)
  })

  it('番号は正確に一致したIATAコードから選ぶ', () => {
    const candidates = '選択肢の中から項番を入力してください。\n1. TYO 東京(全て)\n2. HND 東京(羽田)\n3. NRT 東京(成田)'
    expect(selectAirportCandidate(candidates, 'HND')).toEqual({ answer: '2', label: '東京(羽田)' })
    expect(selectAirportCandidate(candidates, 'HNL')).toBeUndefined()
    expect(selectAirportCandidate(`${candidates}\n4. HND 東京(羽田)`, 'HND')).toBeUndefined()
  })
})

describe('観測済みチャット会話', () => {
  it('観測した質問列で検索へ進み、条件確認の前には検索しない', () => {
    const conversation = new AnaConversation(query)
    const steps = [
      ['ログインをすると会員ステイタスに応じた空席照会結果が表示されます。\nログイン状況を確認しますか？\n「はい」「いいえ」を選択してください。', 'いいえ'],
      ['1.行き先・日付から検索する\n2.マイル数から検索する（ANA国際線特典航空券のみ）', '1'],
      ['直行便のみを検索いたしますか。\n乗継便も含めて検索いたしますか。\n1. 直行便のみを検索\n2. 乗継便も含めて検索', '1'],
      ['ご利用になる特典航空券について、1または2を選択してください。\n1. ANA＋スターアライアンス国際線特典航空券\n2. 提携会社国際線特典航空券', '1'],
      ['出発日を入力してください。', '2026年10月1日'],
      ['ご入力された出発日はこちらでよろしいでしょうか？\n「はい」または「いいえ」を入力してください。\n* 2026/10/01', 'はい'],
      ['出発地を入力してください。', '東京'],
      ['1. TYO 東京(全て)\n2. HND 東京(羽田)\n3. NRT 東京(成田)', '1'],
      ['到着地を入力してください。', 'ホノルル'],
      ['ご希望の搭乗クラスを入力してください。\n※全て、ファースト、ビジネス、プレミアムエコノミー、エコノミーからお選びください。', '全て'],
    ]
    for (const [prompt, answer] of steps) {
      expect(conversation.answer(prompt)).toBe(answer)
      expect(conversation.stage).not.toBe('results')
    }
    expect(conversation.answer(confirmation)).toBe('はい')
    expect(conversation.stage).toBe('results')
  })

  it('未知の質問や別段階の確認には返答せず、不一致の最終条件は拒否する', () => {
    const conversation = new AnaConversation(query)
    expect(conversation.answer('任意の別の質問です。はいを入力してください。')).toBeUndefined()
    expect(conversation.answer(confirmation)).toBeUndefined()
    conversation.stage = 'confirm'
    expect(() => conversation.answer(confirmation.replace('2026/10/01', '2026/10/02'))).toThrow(/一致/)
    conversation.stage = 'date-confirm'
    expect(() => conversation.answer('ご入力された出発日はこちらでよろしいでしょうか？\nはい\n2026/10/03')).toThrow(/一致/)
  })

  it('到着地の入力後に届いた出発空港候補をコードで解決する', () => {
    const conversation = new AnaConversation(query)
    conversation.stage = 'cabin'
    expect(conversation.answer('1. TYO 東京(全て)\n2. HND 東京(羽田)\n3. NRT 東京(成田)')).toBe('1')
    expect(conversation.stage).toBe('cabin')
    expect(() => conversation.answer('1. TYO 東京(全て)\n2. HNL ホノルル')).toThrow(/一意/)
  })

  it('表示本文のみ抽出し、重複cInfo本文やセッション情報を含めない', () => {
    expect(extractBotText({ type: 'bot_response', sessionId: 'should-not-return', message: [
      { type: 'text', component: { type: 'text', payload: { text: '回答本文' } }, cInfo: { body: '回答本文' } },
      { type: 'text', cInfo: { body: '続き' } },
    ] })).toBe('回答本文\n続き')
    expect(extractBotText({ type: 'user_message', message: [{ cInfo: { body: '送信内容' } }] })).toBe('')
    expect(extractBotText(null)).toBe('')
  })
})
