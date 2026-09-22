import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { MemberQuery } from '../src/lib/anaMember'
import { addDays, todayInTokyo, type SearchFilters } from '../src/lib/search'

// 各試験で複数ウィンドウを開くため、同時起動によるイベント配送の遅延を避ける。
test.describe.configure({ mode: 'default' })

const appOrigin = 'http://127.0.0.1:5173'
const anaOrigin = 'https://aswbe-i.ana.co.jp'
const channel = 'milefinder-ana-member-v1'
const today = todayInTokyo()
const departure = addDays(today, 30)
const returnDate = addDays(departure, 3)
const checkedAt = `${today}T03:00:00.000Z`

type SearchMessage = { channel: string; connectionId: string; type: 'search'; id: string; query: MemberQuery; receivedAt: number }
type FixtureWindow = Window & {
  memberFixture: {
    child: Window | null
    appUrl: string
    connectionId: string
    stopped: boolean
    searches: SearchMessage[]
    received: { type: string; connectionId: string }[]
    rejected: { type: string; connectionId?: string }[]
  }
}

const query: MemberQuery = {
  origin: 'TYO', destination: 'HNL', departureDate: departure, returnDate,
  cabin: 'economy', passengers: 2,
}

function fixtureHtml(appUrl: string, connectedQuery: MemberQuery) {
  const connectionId = new URL(appUrl).searchParams.get('ana-bridge')!
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><title>ANA会員連携の試験用ページ</title>
    <button id="open">MileFinderへ接続</button>
    <script>
      window.memberFixture = { child: null, appUrl: ${JSON.stringify(appUrl)}, connectionId: ${JSON.stringify(connectionId)}, searches: [], received: [], rejected: [], stopped: false };
      document.getElementById('open').onclick = () => {
        window.memberFixture.child = window.open(window.memberFixture.appUrl, 'milefinder-member-test');
      };
      window.addEventListener('message', event => {
        const state = window.memberFixture;
        if (state.stopped || event.origin !== ${JSON.stringify(appOrigin)} || event.source !== state.child || event.data?.channel !== ${JSON.stringify(channel)}) return;
        if (event.data.connectionId !== state.connectionId) { state.rejected.push(event.data); return; }
        state.received.push(event.data);
        if (event.data.type === 'disconnect') { state.stopped = true; return; }
        if (event.data.type === 'ready') state.child.postMessage({ channel: ${JSON.stringify(channel)}, connectionId: state.connectionId, type: 'connected', query: ${JSON.stringify(connectedQuery)} }, ${JSON.stringify(appOrigin)});
        if (event.data.type === 'search') state.searches.push({ ...event.data, receivedAt: performance.now() });
      });
    </script></html>`
}

async function openBridge(context: BrowserContext, opener: Page, options: {
  origin?: string
  connectedQuery?: MemberQuery
  filters?: Partial<SearchFilters>
} = {}) {
  const filters: SearchFilters = {
    kind: 'international', origin: 'TYO', region: 'ハワイ', dateFrom: departure,
    dateTo: departure, tripType: 'roundtrip', nights: 3, cabin: 'economy',
    passengers: 2, budget: 80_000, ...options.filters,
  }
  const fixtureOrigin = options.origin ?? anaOrigin
  const appUrl = `${appOrigin}/?ana-member=1&ana-bridge=${randomUUID()}&search=${encodeURIComponent(JSON.stringify(filters))}`
  // ANAを含む外部HTTP要求と、ローカルAPI経由の実照会を全面的に遮断する。
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.origin === fixtureOrigin) return route.fulfill({ contentType: 'text/html', body: fixtureHtml(appUrl, options.connectedQuery ?? query) })
    if (url.origin === appOrigin && !url.pathname.startsWith('/api/ana/')) return route.continue()
    return route.abort('blockedbyclient')
  })
  await opener.goto(`${fixtureOrigin}/member-test`)
  const opened = opener.waitForEvent('popup')
  await opener.getByRole('button', { name: 'MileFinderへ接続' }).click()
  const app = await opened
  await expect(app.getByRole('region', { name: 'ANA会員の空席照会' })).toBeVisible()
  return app
}

async function searchMessage(opener: Page, index: number) {
  await expect.poll(() => opener.evaluate(() => (window as FixtureWindow).memberFixture.searches.length)).toBeGreaterThan(index)
  return opener.evaluate(i => (window as FixtureWindow).memberFixture.searches[i], index)
}

async function send(opener: Page, message: Record<string, unknown>) {
  await opener.evaluate(({ message, origin }) => {
    const state = (window as FixtureWindow).memberFixture
    state.child!.postMessage({ connectionId: state.connectionId, ...message }, origin)
  }, { message: { channel, ...message }, origin: appOrigin })
}

function itinerary(request: MemberQuery = query, overrides: Record<string, unknown> = {}) {
  return {
    outbound: [{ flightNumber: 'NH186', origin: 'HND', destination: 'HNL', date: request.departureDate, bookingClass: 'X' }],
    inbound: [{ flightNumber: 'NH185', origin: 'HNL', destination: 'HND', date: request.returnDate, bookingClass: 'X' }],
    outboundSeats: 3, inboundSeats: 2, totalMiles: 80_000, totalCashJpy: 58_640,
    ...overrides,
  }
}

async function sendResult(opener: Page, request: SearchMessage, itineraries: ReturnType<typeof itinerary>[], overrides: Record<string, unknown> = {}) {
  await send(opener, {
    type: 'result', id: request.id, query: request.query, itineraries, checkedAt,
    source: 'ana-member', partial: true, ...overrides,
  })
}

test('ANAの接続条件を反映し、全員合計の実マイル・諸費用・人数・0席を一覧とCSVへ反映する', async ({ context, page: opener }) => {
  const app = await openBridge(context, opener, {
    filters: { origin: 'HND', dateFrom: addDays(departure, 2), dateTo: addDays(departure, 4), passengers: 1, cabin: 'business' },
  })
  const panel = app.getByRole('region', { name: 'ANA会員の空席照会' })
  const start = panel.getByRole('button', { name: '会員の空席を一括照会' })
  await expect(start).toBeEnabled()
  await expect(app.getByLabel('出発日の開始')).toHaveValue(departure)
  await expect(app.getByLabel('出発日の終了')).toHaveValue(departure)
  await expect(app.getByLabel('人数', { exact: true })).toHaveValue('2')
  await expect(app.getByLabel('座席クラス')).toHaveValue('economy')
  await start.click()
  const request = await searchMessage(opener, 0)
  expect(request.query).toEqual(query)
  await sendResult(opener, request, [
    itinerary(),
    itinerary(query, { outbound: [{ ...itinerary().outbound[0], flightNumber: 'NH182' }], inboundSeats: 1, totalMiles: 79_000 }),
    itinerary(query, { outbound: [{ ...itinerary().outbound[0], flightNumber: 'NH184' }], inboundSeats: 0, inboundWaitlist: true, totalMiles: 78_000 }),
    itinerary(query, { outbound: [{ ...itinerary().outbound[0], flightNumber: 'NH999' }], totalMiles: 80_001 }),
  ])
  await expect(panel.getByRole('status')).toContainText('1 / 1日')
  await expect(panel.locator('tbody tr')).toHaveCount(1)
  await expect(panel.locator('tbody tr')).toContainText('NH186')
  await expect(panel.locator('tbody tr')).toContainText('NH185')
  await expect(panel.locator('tbody tr')).toContainText('80,000')
  await expect(panel.locator('tbody tr')).toContainText('58,640')
  await expect(panel.locator('tbody tr')).not.toContainText('160,000')
  await panel.getByRole('checkbox', { name: '空席なし・空席待ちも表示' }).check()
  await expect(panel.locator('tbody tr')).toHaveCount(3)
  await expect(panel.locator('tbody')).toContainText('0席')
  await expect(panel.locator('tbody')).toContainText('空席待ち')
  await expect(panel.locator('tbody')).not.toContainText('NH999')

  const downloading = app.waitForEvent('download')
  await panel.getByRole('button', { name: '会員空席CSV' }).click()
  const download = await downloading
  expect(download.suggestedFilename()).toBe('milefinder-member-availability.csv')
  const csv = await readFile((await download.path())!, 'utf8')
  expect(csv.startsWith('\uFEFF')).toBe(true)
  expect(csv.trimEnd().slice(1).split('\r\n')).toHaveLength(4)
  expect(csv).toContain('"80000"')
  expect(csv).toContain('"58640"')
  expect(csv).toContain(`"${departure}"`)
  expect(csv).toContain(`"${returnDate}"`)
  expect(csv).toContain(`"${checkedAt}"`)
  expect(csv).toContain('"3","0","未確認","はい","2","いいえ","78000","58640"')
  expect(csv).not.toContain('160000')
  expect(csv).not.toContain('NH999')
})

test('区間・日付・クラス・人数が違う回答と席数不明を拒否し、取得失敗を0席にしない', async ({ context, page: opener }) => {
  const app = await openBridge(context, opener)
  const panel = app.getByRole('region', { name: 'ANA会員の空席照会' })
  const start = panel.getByRole('button', { name: '会員の空席を一括照会' })
  const invalid = [
    { value: itinerary(), envelope: { query: { ...query, passengers: 1 } } },
    { value: itinerary(query, { outbound: [{ ...itinerary().outbound[0], date: addDays(departure, 1) }] }) },
    { value: itinerary(query, { outbound: [{ ...itinerary().outbound[0], destination: 'LAX' }] }) },
    { value: itinerary(query, { outbound: [{ ...itinerary().outbound[0], bookingClass: 'I' }] }) },
    { value: itinerary(query, { inboundSeats: undefined }) },
    { value: itinerary(), envelope: { source: 'ana-public-chat' } },
  ]
  for (const [i, bad] of invalid.entries()) {
    await expect(start).toBeEnabled()
    await start.click()
    const request = await searchMessage(opener, i)
    await sendResult(opener, request, [bad.value], bad.envelope)
    await expect(panel.getByRole('alert')).toContainText(/一致しません|席数・料金を確認できません/)
    await expect(panel.locator('tbody tr')).toHaveCount(0)
    await expect(panel.getByRole('button', { name: '会員空席CSV' })).toHaveCount(0)
    await expect(panel).not.toContainText('0席')
  }
  await start.click()
  const request = await searchMessage(opener, invalid.length)
  await send(opener, { type: 'error', id: request.id, code: 'failed' })
  await expect(panel.getByRole('alert')).toContainText('ANAの回答を確認できませんでした')
  await expect(panel.locator('tbody tr')).toHaveCount(0)
  await expect(panel.getByRole('button', { name: '会員空席CSV' })).toHaveCount(0)
  await expect(panel).not.toContainText('0席')
  await expect(panel).not.toContainText('取得できた回答に、予算と人数を満たす候補はありません')
})

test('後続照会の失敗時も取得済み結果と1 / 2日の進捗を保持し、続行可能と表示しない', async ({ context, page: opener }) => {
  const app = await openBridge(context, opener)
  const panel = app.getByRole('region', { name: 'ANA会員の空席照会' })
  await expect(panel.getByRole('button', { name: '会員の空席を一括照会' })).toBeEnabled()
  await app.getByLabel('出発日の終了').fill(addDays(departure, 1))
  await app.getByRole('button', { name: 'この条件で探す' }).click()
  await panel.getByRole('button', { name: '会員の空席を一括照会' }).click()
  const first = await searchMessage(opener, 0)
  await sendResult(opener, first, [itinerary(first.query)])
  const second = await searchMessage(opener, 1)
  expect(second.query.departureDate).toBe(addDays(departure, 1))
  await expect(panel.getByRole('status')).toContainText('1 / 2日')

  // 実bridgeの通信タイムアウトと同じfailed通知で接続が解除される。
  await send(opener, { type: 'error', id: second.id, code: 'failed' })
  await expect(panel.getByRole('alert')).toContainText('ANAの回答を確認できませんでした')
  await expect(panel.getByRole('status')).toHaveText('会員検索 1 / 2日')
  await expect(panel).not.toContainText('続きの照会が可能です')
  await expect(panel).not.toContainText('1 / 0日')
  await expect(panel.getByRole('button', { name: '次の7日を照会' })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: '会員の空席を一括照会' })).toHaveCount(0)
  await expect(panel.locator('tbody tr')).toHaveCount(1)
  await expect(panel.locator('tbody tr')).toContainText('NH186')
  await expect(panel.locator('tbody tr')).toContainText('NH185')
  await expect(panel.locator('tbody tr')).toContainText(departure)
  await expect(panel.locator('tbody tr')).toContainText('80,000')
  await expect(panel).not.toContainText('取得できた回答に、予算と人数を満たす候補はありません')

  const downloading = app.waitForEvent('download')
  await panel.getByRole('button', { name: '会員空席CSV' }).click()
  const download = await downloading
  const csv = await readFile((await download.path())!, 'utf8')
  expect(csv.trimEnd().slice(1).split('\r\n')).toHaveLength(2)
  expect(csv).toContain(`"${departure}","NH186"`)
  expect(csv).not.toContain(`"${second.query.departureDate}"`)
})

test('中止した照会と条件変更前の照会から遅れて届いた回答を破棄する', async ({ context, page: opener }) => {
  const app = await openBridge(context, opener)
  const panel = app.getByRole('region', { name: 'ANA会員の空席照会' })
  const start = panel.getByRole('button', { name: '会員の空席を一括照会' })
  await start.click()
  const stopped = await searchMessage(opener, 0)
  await panel.getByRole('button', { name: '会員照会を中止' }).click()
  await expect(panel.getByRole('alert')).toContainText('照会を中止しました')
  await expect.poll(() => opener.evaluate(() => (window as FixtureWindow).memberFixture.received.at(-1)?.type)).toBe('cancel')
  await start.click()
  const retried = await searchMessage(opener, 1)
  await sendResult(opener, stopped, [itinerary(query, { outbound: [{ ...itinerary().outbound[0], flightNumber: 'NH999' }] })])
  await sendResult(opener, retried, [itinerary(query, { outbound: [{ ...itinerary().outbound[0], flightNumber: 'NH188' }] })])
  await expect(panel.locator('tbody tr')).toHaveCount(1)
  await expect(panel.locator('tbody tr')).toContainText('NH188')
  await expect(panel).not.toContainText('NH999')

  const changeDate = async (offset: number) => {
    await app.getByLabel('出発日の開始').fill(addDays(departure, offset))
    await app.getByLabel('出発日の終了').fill(addDays(departure, offset))
    await app.getByLabel('人数', { exact: true }).selectOption('3')
    await app.getByLabel('使えるマイル').fill('120000')
    await app.getByRole('button', { name: 'この条件で探す' }).click()
    await expect(panel.locator('tbody tr')).toHaveCount(0)
  }
  await changeDate(1)
  await start.click()
  const outdated = await searchMessage(opener, 2)
  await changeDate(2)
  await start.click()
  const current = await searchMessage(opener, 3)
  expect(current.query).toEqual({ ...query, departureDate: addDays(departure, 2), returnDate: addDays(returnDate, 2), passengers: 3 })
  await sendResult(opener, outdated, [itinerary(outdated.query, { outbound: [{ ...itinerary(outdated.query).outbound[0], flightNumber: 'NH997' }], inboundSeats: 3, totalMiles: 120_000 })])
  await sendResult(opener, current, [itinerary(current.query, { outbound: [{ ...itinerary(current.query).outbound[0], flightNumber: 'NH190' }], inboundSeats: 3, totalMiles: 120_000 })])
  await expect(panel.getByRole('status')).toContainText('1 / 1日')
  await expect(panel.locator('tbody tr')).toHaveCount(1)
  await expect(panel.locator('tbody tr')).toContainText('NH190')
  await expect(panel.locator('tbody tr')).toContainText(addDays(departure, 2))
  await expect(panel.locator('tbody tr')).toContainText('120,000')
  await expect(panel).not.toContainText(/NH997|NH999|NH188/)
})

test('同じANA originでも接続元以外のウィンドウと別channelからの結果を拒否する', async ({ context, page: opener }) => {
  const app = await openBridge(context, opener)
  const panel = app.getByRole('region', { name: 'ANA会員の空席照会' })
  await panel.getByRole('button', { name: '会員の空席を一括照会' }).click()
  const request = await searchMessage(opener, 0)
  const rogue = {
    channel, connectionId: request.connectionId, type: 'result', id: request.id, query: request.query,
    itineraries: [itinerary(query, { outbound: [{ ...itinerary().outbound[0], flightNumber: 'NH999' }] })],
    checkedAt, source: 'ana-member', partial: true,
  }
  const opened = opener.waitForEvent('popup')
  await opener.evaluate(url => { window.open(url, 'same-ana-origin-other-window') }, `${anaOrigin}/member-test-other`)
  const sibling = await opened
  await sibling.waitForLoadState('domcontentloaded')
  await sibling.evaluate(({ message, origin }) => {
    ((window.opener as FixtureWindow).memberFixture.child!).postMessage(message, origin)
  }, { message: rogue, origin: appOrigin })
  await send(opener, { ...rogue, channel: 'unrelated-channel' })
  // イベント配送後にも元の照会が待機中であることを確認する。
  await app.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await expect(panel.getByRole('button', { name: '会員照会を中止' })).toBeVisible()
  await expect(panel.locator('tbody tr')).toHaveCount(0)
  await sendResult(opener, request, [itinerary()])
  await expect(panel.locator('tbody tr')).toHaveCount(1)
  await expect(panel.locator('tbody tr')).toContainText('NH186')
  await expect(panel).not.toContainText('NH999')
})

test('ANAに似た別originのopenerからconnectedが届いても接続しない', async ({ context, page: opener }) => {
  const app = await openBridge(context, opener, { origin: 'https://aswbe-i.ana.co.jp.example.test' })
  const panel = app.getByRole('region', { name: 'ANA会員の空席照会' })
  await send(opener, { type: 'connected', query })
  await app.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await expect(panel.getByText('ANAで国際線・往復・エコノミーを一度検索し、フライト一覧を表示してください。')).toBeVisible()
  await expect(panel.getByRole('button', { name: '会員の空席を一括照会' })).toHaveCount(0)
  await expect(panel).not.toContainText('会員の検索結果に接続中')
  expect(await opener.evaluate(() => (window as FixtureWindow).memberFixture.searches.length)).toBe(0)
})

test('再接続時の旧ページの切断通知と旧connectionIdの接続・結果・エラーを無視する', async ({ context, page: opener }) => {
  const app = await openBridge(context, opener)
  const panel = app.getByRole('region', { name: 'ANA会員の空席照会' })
  const start = panel.getByRole('button', { name: '会員の空席を一括照会' })
  await expect(start).toBeEnabled()
  const previousId = new URL(app.url()).searchParams.get('ana-bridge')!
  const nextId = randomUUID()

  // 実bridgeと同じ名前のウィンドウを再利用する。旧画面のbeforeunloadも実際に発生する。
  const navigated = app.waitForURL(url => url.searchParams.get('ana-bridge') === nextId)
  await opener.evaluate(connectionId => {
    const state = (window as FixtureWindow).memberFixture
    const url = new URL(state.appUrl)
    url.searchParams.set('ana-bridge', connectionId)
    state.connectionId = connectionId
    state.appUrl = url.href
    state.child = window.open(state.appUrl, 'milefinder-member-test')
  }, nextId)
  await navigated
  await expect.poll(() => opener.evaluate(id => (window as FixtureWindow).memberFixture.rejected.some(message => message.type === 'disconnect' && message.connectionId === id), previousId)).toBe(true)
  await expect(start).toBeEnabled()
  expect(await opener.evaluate(() => (window as FixtureWindow).memberFixture.stopped)).toBe(false)
  await start.click()
  const request = await searchMessage(opener, 0)
  expect(request.connectionId).toBe(nextId)

  await send(opener, { type: 'connected', connectionId: previousId, query: { ...query, destination: 'LAX' } })
  await send(opener, { type: 'error', connectionId: previousId, id: request.id, code: 'failed' })
  const stale = itinerary(query, { outbound: [{ ...itinerary().outbound[0], flightNumber: 'NH999' }] })
  await sendResult(opener, request, [stale], { connectionId: previousId })
  await sendResult(opener, request, [stale], { connectionId: undefined })
  await app.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await expect(panel.getByRole('button', { name: '会員照会を中止' })).toBeVisible()
  await expect(panel.locator('tbody tr')).toHaveCount(0)
  await expect(panel.getByRole('alert')).toHaveCount(0)
  await expect(panel).toContainText('TYO → HNL · 会員の検索結果に接続中')
  await expect(panel).not.toContainText('TYO → LAX')

  await sendResult(opener, request, [itinerary()])
  await expect(panel.locator('tbody tr')).toHaveCount(1)
  await expect(panel.locator('tbody tr')).toContainText('NH186')
  await expect(panel).not.toContainText('NH999')
})

test('日別の照会を1秒以上あけて直列実行し、7日で止まって続きは明示操作で開始する', async ({ context, page: opener }) => {
  const app = await openBridge(context, opener)
  const panel = app.getByRole('region', { name: 'ANA会員の空席照会' })
  await expect(panel.getByRole('button', { name: '会員の空席を一括照会' })).toBeEnabled()
  await app.getByLabel('出発日の終了').fill(addDays(departure, 7))
  await app.getByRole('button', { name: 'この条件で探す' }).click()
  await panel.getByRole('button', { name: '会員の空席を一括照会' }).click()
  let previous: SearchMessage | undefined
  for (let i = 0; i < 7; i++) {
    const request = await searchMessage(opener, i)
    expect(request.query).toEqual({ ...query, departureDate: addDays(departure, i), returnDate: addDays(returnDate, i) })
    if (previous) expect(request.receivedAt - previous.receivedAt).toBeGreaterThanOrEqual(950)
    expect(await opener.evaluate(() => (window as FixtureWindow).memberFixture.searches.length)).toBe(i + 1)
    await sendResult(opener, request, [itinerary(request.query)])
    previous = request
  }
  const next = panel.getByRole('button', { name: '次の7日を照会' })
  await expect(next).toBeEnabled()
  await expect(panel.getByRole('status')).toContainText('7 / 8日')
  await expect(panel.locator('tbody tr')).toHaveCount(7)
  expect(await opener.evaluate(() => (window as FixtureWindow).memberFixture.searches.length)).toBe(7)
  await next.click()
  const final = await searchMessage(opener, 7)
  expect(final.query.departureDate).toBe(addDays(departure, 7))
  await sendResult(opener, final, [itinerary(final.query)])
  await expect(panel.getByRole('status')).toContainText('8 / 8日')
  await expect(panel.locator('tbody tr')).toHaveCount(8)
  await expect(panel.getByRole('button', { name: '会員の空席を一括照会' })).toBeDisabled()
})
