import { test, expect, type BrowserContext, type Page, type Route } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { addDays, todayInTokyo, type SearchFilters } from '../src/lib/search'
import type { MemberQuery } from '../src/lib/anaMember'

test.describe.configure({ mode: 'default' })
const site = 'https://milefinder-ana-awards.raisin7524.chatgpt.site'
const local = 'http://127.0.0.1:5173'
const ana = 'https://aswbe-i.ana.co.jp'
const channel = 'milefinder-ana-member-v1'
const cors = { 'Access-Control-Allow-Origin': local, 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS' }
const accessToken = 'a'.repeat(64)
const workerToken = 'test-only-worker-token-0123456789abcdef'
const today = todayInTokyo()
const checkedAt = `${today}T03:00:00.000Z`
const query: MemberQuery = { origin: 'TYO', destination: 'HNL', departureDate: addDays(today, 30), returnDate: addDays(today, 33), cabin: 'economy', passengers: 2 }
const initialFilters: SearchFilters = { kind: 'international', origin: 'TYO', region: 'ハワイ', dateFrom: query.departureDate, dateTo: query.departureDate, tripType: 'roundtrip', nights: 3, cabin: 'economy', passengers: 2, budget: 80_000 }
const filtersUrl = `${site}/?search=${encodeURIComponent(JSON.stringify(initialFilters))}`
type Handler = (route: Route, url: URL) => Promise<void> | void

function itinerary(q = query, overrides: Record<string, unknown> = {}) {
  return {
    outbound: [{ flightNumber: 'NH186', origin: 'HND', destination: 'HNL', date: q.departureDate, bookingClass: 'X' }],
    inbound: [{ flightNumber: 'NH185', origin: 'HNL', destination: 'HND', date: q.returnDate, bookingClass: 'X' }],
    outboundSeats: 3, inboundSeats: 2, totalMiles: 80_000, totalCashJpy: 58_640, ...overrides,
  }
}
function result(q = query, items = [itinerary(q)]) {
  return { query: q, itineraries: items, checkedAt, source: 'ana-member', partial: true }
}
const status = { connected: true, query, busy: false }

async function install(context: BrowserContext, api: Handler, anaHtml?: string) {
  // 公開サイト・ANAへの実通信と、実管理キーのローカル読取りを禁止する。
  await context.routeWebSocket('**/*', socket => socket.close())
  await context.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin === site && route.request().method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: cors }); return }
    if (url.origin === ana && anaHtml) { await route.fulfill({ contentType: 'text/html', body: anaHtml }); return }
    if ([site, local].includes(url.origin) && url.pathname.startsWith('/api/')) { await api(route, url); return }
    if ([site, local].includes(url.origin)) {
      const response = await route.fetch({ url: `${local}${url.pathname}${url.search}` })
      await route.fulfill({ response }); return
    }
    await route.abort('blockedbyclient')
  })
}
async function fallback(route: Route) { await route.fulfill({ status: 404, json: { error: 'mock_not_defined' } }) }
async function openPhone(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(filtersUrl)
  return page.getByRole('region', { name: 'ANA会員の空席照会' })
}

test('公開スマホ画面でログインなしに会員結果と実料金を取得し、CSVを出力する', async ({ context, page }, testInfo) => {
  let gets = 0
  await install(context, async (route, url) => {
    if (url.pathname === '/api/member/status') return route.fulfill({ json: status })
    if (url.pathname === '/api/member/jobs') {
      expect(route.request().postDataJSON()).toEqual({ query })
      expect(route.request().headers().authorization).toBeUndefined()
      return route.fulfill({ status: 202, json: { id: 'phone-job', accessToken, status: 'queued' } })
    }
    if (url.pathname === '/api/member/jobs/phone-job') {
      expect(route.request().headers().authorization).toBe(`Bearer ${accessToken}`)
      gets++
      const items = [itinerary(), itinerary(query, { outbound: [{ ...itinerary().outbound[0], flightNumber: 'NH184' }], inboundSeats: 0, inboundWaitlist: true })]
      return route.fulfill({ json: { id: 'phone-job', status: gets === 1 ? 'running' : 'succeeded', query, ...(gets === 1 ? {} : { result: result(query, items) }) } })
    }
    return fallback(route)
  })
  const panel = await openPhone(page)
  await panel.getByRole('button', { name: '会員の空席を一括照会' }).click()
  await expect(panel.locator('tbody tr')).toHaveCount(1)
  await expect(panel.locator('tbody tr')).toContainText('80,000')
  await expect(panel.locator('tbody tr')).toContainText('58,640')
  await expect(panel).not.toContainText('ブックマーク')
  await expect(page.getByLabel('ワーカートークン')).toHaveCount(0)
  await panel.getByRole('checkbox', { name: '空席なし・空席待ちも表示' }).check()
  await expect(panel.locator('tbody tr')).toHaveCount(2)
  const downloaded = page.waitForEvent('download')
  await panel.getByRole('button', { name: '会員空席CSV' }).click()
  const download = await downloaded
  expect(download.suggestedFilename()).toBe('milefinder-member-availability.csv')
  const csv = await readFile((await download.path())!, 'utf8')
  expect(csv.trimEnd().slice(1).split('\r\n')).toHaveLength(3)
  expect(csv).toContain('"80000","58640"')
  expect(csv).not.toContain(accessToken)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('phone-member.png'), fullPage: true })
})

test('公開接続がofflineや通信失敗なら未確認と示し、管理者向けの操作を求めない', async ({ context, page }) => {
  let anonymousCalls = 0
  let rejection: { code: string; status: number } | null = null
  const providerError = 'ANAの空席回答を取得できませんでした。時間をおいて再度お試しください。空席なしとは判定していません。'
  await install(context, (route, url) => {
    if (url.pathname === '/api/member/status') return route.fulfill({ json: { connected: false, query: null, busy: false } })
    if (url.pathname === '/api/ana/availability') {
      anonymousCalls++
      if (rejection) return route.fulfill({ status: rejection.status, json: { error: rejection.code } })
      return anonymousCalls === 1
        ? route.fulfill({ status: 502, contentType: 'text/html', body: '<!doctype html><title>Unavailable</title>' })
        : route.fulfill({ status: 200, contentType: 'application/json', body: ` \n\t \n${JSON.stringify({ error: providerError })}` })
    }
    return fallback(route)
  })
  const panel = await openPhone(page)
  await expect(panel).toContainText('現在、会員空席の照会に接続できません')
  await expect(panel).toContainText('空席なしとは判定していません')
  await expect(panel.getByRole('button', { name: '会員の空席を一括照会' })).toHaveCount(0)
  await expect(panel).not.toContainText('フライト一覧を表示してください')
  await expect(panel).not.toContainText('ブックマーク')
  await expect(page.getByLabel('ワーカートークン')).toHaveCount(0)
  await expect(panel.locator('tbody tr')).toHaveCount(0)
  const anonymous = page.getByRole('region', { name: '実際の空席を一括照会' })
  await anonymous.getByRole('button', { name: '空席をまとめて照会' }).click()
  await expect(anonymous.locator('.live-notice')).toContainText('時間をおいて再度お試しください。空席なしとは判定していません。')
  await expect(anonymous).not.toContainText('npm run')
  await expect(anonymous.getByRole('button', { name: '空席CSV' })).toBeDisabled()
  // heartbeatの空白を含むHTTP 200でも、error本文を先に判定する。
  await anonymous.getByRole('button', { name: '空席をまとめて照会' }).click()
  await expect(anonymous.locator('.live-notice')).toHaveText(providerError)
  await expect(anonymous.getByRole('status')).toContainText('照会を停止しました')
  await expect(anonymous).not.toContainText('空席回答の形式を確認できませんでした')
  await expect(anonymous.locator('tbody tr')).toHaveCount(0)
  await expect(anonymous.getByRole('button', { name: '空席CSV' })).toBeDisabled()
  const rejections = [
    { code: 'busy', status: 429, text: 'ほかの空席照会を処理中です。少し待って' },
    { code: 'rate_limited', status: 429, text: 'しばらく待って' },
    { code: 'invalid_query', status: 400, text: '検索条件を確認して' },
    { code: 'storage_unavailable', status: 503, text: '空席回答を取得できませんでした' },
    { code: 'unknown_backend_code', status: 500, text: '空席回答を取得できませんでした' },
  ]
  for (const scenario of rejections) {
    rejection = scenario
    await anonymous.getByRole('button', { name: '空席をまとめて照会' }).click()
    await expect(anonymous.locator('.live-notice')).toContainText(scenario.text)
    await expect(anonymous.locator('.live-notice')).not.toContainText(scenario.code)
    await expect(anonymous.getByRole('button', { name: '空席CSV' })).toBeDisabled()
  }
  expect(anonymousCalls).toBe(2 + rejections.length)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('公開ジョブの中止は待機分だけ取り消し、実行中の照会と遅い回答を表示へ混ぜない', async ({ context, page }) => {
  let creates = 0
  const deleted: string[] = []
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let runningPolled = false
  await install(context, async (route, url) => {
    if (url.pathname === '/api/member/status') return route.fulfill({ json: status })
    if (url.pathname === '/api/member/jobs') {
      creates++
      return route.fulfill({ status: 202, json: { id: `job-${creates}`, accessToken, status: creates === 2 ? 'running' : 'queued' } })
    }
    if (url.pathname.startsWith('/api/member/jobs/')) {
      const id = url.pathname.split('/').at(-1)!
      expect(route.request().headers().authorization).toBe(`Bearer ${accessToken}`)
      if (route.request().method() === 'DELETE') { deleted.push(id); return route.fulfill({ json: { id, status: 'cancelled' } }) }
      if (id === 'job-1') return route.fulfill({ json: { id, query, status: 'queued' } })
      if (id === 'job-2') { runningPolled = true; await held; await route.fulfill({ json: { id, query, status: 'succeeded', result: result(query, [itinerary(query, { outbound: [{ ...itinerary().outbound[0], flightNumber: 'NH999' }] })]) } }).catch(() => {}); return }
      return route.fulfill({ json: { id, query, status: 'succeeded', result: result() } })
    }
    return fallback(route)
  })
  const panel = await openPhone(page)
  const start = panel.getByRole('button', { name: '会員の空席を一括照会' })
  await start.click()
  await expect.poll(() => creates).toBe(1)
  await panel.getByRole('button', { name: '会員照会を中止' }).click()
  await expect.poll(() => deleted).toEqual(['job-1'])
  await start.click()
  await expect.poll(() => runningPolled).toBe(true)
  await panel.getByRole('button', { name: '会員照会を中止' }).click()
  await expect(panel.getByRole('alert')).toContainText('処理中の照会は完了まで継続します')
  release()
  await start.click()
  await expect(panel.locator('tbody tr')).toHaveCount(1)
  await expect(panel.locator('tbody tr')).toContainText('NH186')
  await expect(panel).not.toContainText('NH999')
  expect(deleted).toEqual(['job-1'])
})

test('公開照会の後続失敗でも取得済み回答と進捗を保持する', async ({ context, page }) => {
  const queries: MemberQuery[] = []
  await install(context, async (route, url) => {
    if (url.pathname === '/api/member/status') return route.fulfill({ json: status })
    if (url.pathname === '/api/member/jobs') {
      queries.push(route.request().postDataJSON().query)
      return route.fulfill({ status: 202, json: { id: `partial-${queries.length}`, accessToken, status: 'queued' } })
    }
    if (url.pathname === '/api/member/jobs/partial-1') return route.fulfill({ json: { id: 'partial-1', status: 'succeeded', query: queries[0], result: result(queries[0]) } })
    if (url.pathname === '/api/member/jobs/partial-2') return route.fulfill({ json: { id: 'partial-2', status: 'failed', query: queries[1], error: 'timeout' } })
    return fallback(route)
  })
  const panel = await openPhone(page)
  await expect(panel.getByRole('button', { name: '会員の空席を一括照会' })).toBeEnabled()
  await page.getByLabel('出発日の終了').fill(addDays(query.departureDate, 1))
  await page.getByRole('button', { name: 'この条件で探す' }).click()
  await panel.getByRole('button', { name: '会員の空席を一括照会' }).click()
  await expect(panel.getByRole('alert')).toContainText('空席なしとは判定していません')
  await expect(panel.getByRole('status')).toContainText('1 / 2日')
  await expect(panel.locator('tbody tr')).toHaveCount(1)
  await expect(panel.locator('tbody tr')).toContainText('NH186')
})

type WorkerWindow = Window & { workerFixture: { child: Window; messages: { type: string; id: string; query: MemberQuery; connectionId: string }[] } }
async function openWorker(context: BrowserContext, opener: Page, api: Handler) {
  const connectionId = randomUUID()
  const target = `${local}/?member-worker=1&ana-member=1&ana-bridge=${connectionId}&api-origin=${encodeURIComponent(site)}`
  const html = `<!doctype html><html lang="ja"><meta charset="utf-8"><button id="open">管理接続</button><script>
    window.workerFixture = { child: null, messages: [] };
    document.getElementById('open').onclick = () => { window.workerFixture.child = window.open(${JSON.stringify(target)}, 'worker-test'); };
    window.addEventListener('message', e => {
      if(e.origin !== ${JSON.stringify(local)} || e.source !== window.workerFixture.child || e.data?.channel !== ${JSON.stringify(channel)} || e.data.connectionId !== ${JSON.stringify(connectionId)}) return;
      window.workerFixture.messages.push(e.data);
      if(e.data.type === 'ready') e.source.postMessage({channel:${JSON.stringify(channel)}, connectionId:${JSON.stringify(connectionId)},type:'connected',query:${JSON.stringify(query)}},${JSON.stringify(local)});
    });
  </script></html>`
  await install(context, api, html)
  await opener.goto(`${ana}/mock-worker`)
  const popup = opener.waitForEvent('popup')
  await opener.getByRole('button', { name: '管理接続' }).click()
  const worker = await popup
  await expect(worker.getByRole('region', { name: '会員検索ワーカー' })).toBeVisible()
  return worker
}

test('ローカルworkerだけが管理tokenを保持し、直列のANA結果を検証して公開APIへ返す', async ({ context, page: opener }) => {
  let configurationCalls = 0, claims = 0
  const heartbeats: unknown[] = [], posted: Record<string, unknown>[] = []
  const worker = await openWorker(context, opener, async (route, url) => {
    if (url.pathname === '/api/member-worker/local-config') { configurationCalls++; return fallback(route) }
    expect(route.request().headers().authorization).toBe(`Bearer ${workerToken}`)
    if (url.pathname === '/api/worker/heartbeat') { heartbeats.push(route.request().postDataJSON().query); return route.fulfill({ headers: cors, json: { ok: true, busy: false } }) }
    if (url.pathname === '/api/worker/claim') {
      claims++
      return route.fulfill({ headers: cors, json: { job: { id: `worker-${claims}`, leaseId: `lease-${claims}`, query, expiresAt: new Date(Date.now() + 90_000).toISOString() } } })
    }
    if (url.pathname.startsWith('/api/worker/jobs/')) { posted.push(route.request().postDataJSON()); return route.fulfill({ headers: cors, json: { ok: true } }) }
    return fallback(route)
  })
  await worker.getByLabel('ワーカートークン').fill(workerToken)
  await worker.getByRole('button', { name: '接続を開始' }).click()
  await expect.poll(() => opener.evaluate(() => (window as WorkerWindow).workerFixture.messages.filter(m => m.type === 'search').length)).toBe(1)
  await expect.poll(() => heartbeats.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
  expect(claims).toBe(1)
  const first = await opener.evaluate(() => (window as WorkerWindow).workerFixture.messages.find(m => m.type === 'search')!)
  await opener.evaluate(({ request, answer, origin, channel }) => (window as WorkerWindow).workerFixture.child.postMessage({ ...answer, channel, connectionId: request.connectionId, type: 'result', id: request.id }, origin), { request: first, answer: result(), origin: local, channel })
  await expect.poll(() => posted.length).toBe(1)
  expect(posted[0]).toEqual({ leaseId: 'lease-1', result: result() })
  await expect.poll(() => opener.evaluate(() => (window as WorkerWindow).workerFixture.messages.filter(m => m.type === 'search').length)).toBe(2)
  const second = await opener.evaluate(() => (window as WorkerWindow).workerFixture.messages.filter(m => m.type === 'search')[1])
  await opener.evaluate(({ request, answer, origin, channel }) => (window as WorkerWindow).workerFixture.child.postMessage({ ...answer, channel, connectionId: request.connectionId, type: 'result', id: request.id }, origin), { request: second, answer: result(query, [itinerary(query, { inboundSeats: null })]), origin: local, channel })
  await expect(worker.getByRole('status')).toContainText('接続停止・再接続が必要')
  await expect.poll(() => posted.length).toBe(2)
  expect(posted[1]).toEqual({ leaseId: 'lease-2', error: 'failed' })
  await expect.poll(() => heartbeats.at(-1)).toBeNull()
  expect(configurationCalls).toBe(1)
  expect(await opener.evaluate(() => JSON.stringify((window as WorkerWindow).workerFixture.messages))).not.toContain(workerToken)
  expect(worker.url()).not.toContain(workerToken)
})

test('ローカル設定のtokenを一度だけ読んで自動接続し、停止時に一時保存を削除する', async ({ context, page: opener }) => {
  let reads = 0
  const worker = await openWorker(context, opener, async (route, url) => {
    if (url.pathname === '/api/member-worker/local-config') { reads++; return route.fulfill({ json: { apiOrigin: site, token: workerToken } }) }
    expect(route.request().headers().authorization).toBe(`Bearer ${workerToken}`)
    if (url.pathname === '/api/worker/heartbeat') return route.fulfill({ headers: cors, json: { ok: true, busy: false } })
    if (url.pathname === '/api/worker/claim') return route.fulfill({ headers: cors, json: { job: null } })
    return fallback(route)
  })
  await expect(worker.getByRole('status')).toContainText('照会を待機中')
  expect(reads).toBe(1)
  expect(await worker.evaluate(key => sessionStorage.getItem(key), `milefinder:member-worker:${site}`)).toBe(workerToken)
  expect(await opener.evaluate(() => JSON.stringify((window as WorkerWindow).workerFixture.messages))).not.toContain(workerToken)
  await worker.getByRole('button', { name: '接続を停止' }).click()
  expect(await worker.evaluate(key => sessionStorage.getItem(key), `milefinder:member-worker:${site}`)).toBeNull()
  await expect(worker.getByRole('status')).toContainText('停止しました')
})

test('管理用fragmentを直ちにURLから除去し、許可されていないAPI originへ送らない', async ({ context, page }) => {
  let apiRequests = 0
  await install(context, route => { apiRequests++; return fallback(route) })
  await page.goto(`${local}/?member-worker=1&api-origin=${encodeURIComponent('https://untrusted.example')}#worker-token=${workerToken}`)
  await expect(page.getByRole('region', { name: '会員検索ワーカー' })).toBeVisible()
  expect(new URL(page.url()).hash).toBe('')
  expect(apiRequests).toBe(0)
  await expect(page.getByRole('button', { name: '接続を開始' })).toHaveCount(0)
  expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toContain(workerToken)
})
