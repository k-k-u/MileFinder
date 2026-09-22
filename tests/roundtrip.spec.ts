import { test, expect, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import type { AnaChatOffer } from '../src/lib/anaChat'
import { addDays, type SearchFilters } from '../src/lib/search'

const today = '2026-09-23'
const departure = addDays(today, 30)
const nights = 3
const returnDate = addDays(departure, nights)
const outboundCheckedAt = '2026-09-23T03:00:00.000Z'
const inboundCheckedAt = '2026-09-23T03:01:00.000Z'
const endpoint = '**/api/ana/availability'

function outbound(overrides: Partial<AnaChatOffer> = {}): AnaChatOffer {
  return {
    flightNumber: 'NH186', originLabel: '東京(羽田)', destinationLabel: 'ホノルル(オアフ島)',
    date: departure, time: '21:30', cabin: 'economy', seats: 3,
    source: 'ana-public-chat', accountScope: 'anonymous', ...overrides,
  }
}

function inbound(overrides: Partial<AnaChatOffer> = {}): AnaChatOffer {
  return outbound({
    flightNumber: 'NH185', originLabel: 'ホノルル(オアフ島)', destinationLabel: '東京(羽田)',
    date: returnDate, time: '11:45', seats: 2, ...overrides,
  })
}

function reply(offers: AnaChatOffer[], checkedAt: string) {
  return { offers, checkedAt, partial: false, notes: [], source: 'ana-public-chat', accountScope: 'anonymous' }
}

async function openSearch(page: Page) {
  const filters: SearchFilters = {
    kind: 'international', origin: 'TYO', region: 'ハワイ',
    dateFrom: departure, dateTo: departure, tripType: 'roundtrip', nights,
    cabin: 'economy', passengers: 2, budget: 80_000,
  }
  await page.goto(`/?search=${encodeURIComponent(JSON.stringify(filters))}`)
  const panel = page.getByRole('region', { name: '実際の空席を一括照会' })
  await expect(panel).toBeVisible()
  await expect(panel.locator('.live-query-count')).toContainText('2回の照会')
  return panel
}

async function readRoundtripCsv(page: Page): Promise<string[][]> {
  const downloading = page.waitForEvent('download')
  await page.getByRole('button', { name: '空席CSV', exact: true }).click()
  const download = await downloading
  expect(download.suggestedFilename()).toBe('milefinder-roundtrip-availability.csv')
  const csv = await readFile((await download.path())!, 'utf8')
  expect(csv.startsWith('\uFEFF')).toBe(true)
  return csv.trimEnd().slice(1).split('\r\n').map(row => row.slice(1, -1).split('","'))
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(outboundCheckedAt))
  // 未定義の照会も遮断し、往復の試験から実ANAサービスへ通信しない。
  await page.route('**/api/ana/**', route => route.fulfill({
    status: 503, json: { error: 'テスト用stubが未定義です。' },
  }))
})

test('両方向の回答がそろってから予算内の往復を表示し、CSVは現地日付の1組1行になる', async ({ page }) => {
  let calls = 0
  let returnRequested = false
  let releaseReturn!: () => void
  const waitForReturn = new Promise<void>(resolve => { releaseReturn = resolve })
  await page.route(endpoint, async route => {
    calls += 1
    const query = route.request().postDataJSON() as { origin: string }
    if (query.origin === 'TYO') {
      expect(route.request().postDataJSON()).toEqual({ origin: 'TYO', destination: 'HNL', dateFrom: departure, dateTo: departure })
      await route.fulfill({ json: reply([outbound()], outboundCheckedAt) })
      return
    }
    expect(route.request().postDataJSON()).toEqual({ origin: 'HNL', destination: 'TYO', dateFrom: returnDate, dateTo: returnDate })
    returnRequested = true
    await waitForReturn
    await route.fulfill({ json: reply([inbound()], inboundCheckedAt) })
  })
  const panel = await openSearch(page)
  await panel.getByRole('button', { name: '空席をまとめて照会' }).click()
  await expect.poll(() => returnRequested).toBe(true)
  await expect(panel.getByRole('status')).toContainText('1 / 2')
  await expect(panel.locator('tbody tr')).toHaveCount(0)
  await expect(panel.locator('.live-empty')).toContainText('取得済み 1件')
  await expect(panel.locator('.live-empty')).toContainText('未確認')
  await expect(panel.getByRole('button', { name: '空席CSV' })).toBeDisabled()

  releaseReturn()
  await expect(panel.getByRole('status')).toContainText('照会が終了しました')
  await expect(panel.locator('.live-results-top')).toContainText('人数を満たす往復候補 1組')
  const row = panel.locator('tbody tr')
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('NH186')
  await expect(row).toContainText('NH185')
  await expect(row).toContainText(`${returnDate} 11:45`)
  await expect(row).toContainText('往路 3席')
  await expect(row).toContainText('復路 2席')
  await expect(row).toContainText('80,000')
  await expect(row).toContainText('往路 9/23 12:00')
  await expect(row).toContainText('復路 9/23 12:01')

  const [header, data, ...extraRows] = await readRoundtripCsv(page)
  expect(extraRows).toHaveLength(0)
  expect(header[0]).toBe('往路出発日（現地）')
  expect(header[7]).toBe('復路出発日（現地）')
  expect(data.slice(0, 7)).toEqual([departure, 'NH186', '東京(羽田)', 'ホノルル(オアフ島)', '21:30', '3', outboundCheckedAt])
  expect(data.slice(7, 14)).toEqual([returnDate, 'NH185', 'ホノルル(オアフ島)', '東京(羽田)', '11:45', '2', inboundCheckedAt])
  expect(data.slice(14, 18)).toEqual(['economy', '2', 'はい', '80000'])
  expect(data[20]).toContain('旅程全体の予約可否は未確認')
  expect(calls).toBe(2)

  // 片道ではなく両方向・全員分の予算と比較し、1マイル不足なら照会候補にしない。
  await page.getByLabel('使えるマイル').fill('79999')
  await page.getByRole('button', { name: 'この条件で探す' }).click()
  await expect(panel.getByRole('button', { name: '空席をまとめて照会' })).toBeDisabled()
  await expect(panel.locator('tbody tr')).toHaveCount(0)
  expect(calls).toBe(2)
})

test('東京まとめ検索でも成田発と羽田着を往復の組み合わせにしない', async ({ page }) => {
  await page.route(endpoint, route => {
    const query = route.request().postDataJSON() as { origin: string }
    return route.fulfill({ json: query.origin === 'TYO'
      ? reply([outbound(), outbound({ flightNumber: 'NH184', originLabel: '東京(成田)' })], outboundCheckedAt)
      : reply([inbound()], inboundCheckedAt) })
  })
  const panel = await openSearch(page)
  await panel.getByRole('button', { name: '空席をまとめて照会' }).click()
  await expect(panel.getByRole('status')).toContainText('照会が終了しました')
  await expect(panel.locator('.live-results-top')).toContainText('人数を満たす往復候補 1組')
  await panel.getByRole('checkbox', { name: '残席不足・0席も表示' }).check()
  await expect(panel.locator('tbody tr')).toHaveCount(1)
  await expect(panel.locator('tbody tr')).toContainText('NH186')
  await expect(panel.locator('tbody tr')).toContainText('NH185')
  await expect(panel.locator('tbody')).not.toContainText('NH184')
  const rows = await readRoundtripCsv(page)
  expect(rows).toHaveLength(2)
  expect(rows[1]).not.toContain('NH184')
})

test('復路0席は人数を満たす往復へ数えず、切替とCSVで明示する', async ({ page }) => {
  await page.route(endpoint, route => {
    const query = route.request().postDataJSON() as { origin: string }
    return route.fulfill({ json: query.origin === 'TYO'
      ? reply([outbound()], outboundCheckedAt)
      : reply([inbound({ seats: 0 })], inboundCheckedAt) })
  })
  const panel = await openSearch(page)
  await panel.getByRole('button', { name: '空席をまとめて照会' }).click()
  await expect(panel.getByRole('status')).toContainText('照会が終了しました')
  await expect(panel.locator('.live-results-top')).toContainText('人数を満たす往復候補 0組')
  await expect(panel.locator('tbody tr')).toHaveCount(0)
  await expect(panel.getByRole('button', { name: '空席CSV' })).toBeDisabled()
  await panel.getByRole('checkbox', { name: '残席不足・0席も表示' }).check()
  await expect(panel.locator('tbody tr')).toHaveCount(1)
  await expect(panel.locator('.seats-empty')).toHaveText('復路 0席')
  const rows = await readRoundtripCsv(page)
  expect(rows).toHaveLength(2)
  expect(rows[1][12]).toBe('0')
  expect(rows[1][16]).toBe('いいえ')
  await panel.getByRole('checkbox', { name: '残席不足・0席も表示' }).uncheck()
  await expect(panel.locator('tbody tr')).toHaveCount(0)
})

test('復路502では取得済み往路だけで組み合わせず、往復空席なしと断定しない', async ({ page }) => {
  await page.route(endpoint, route => {
    const query = route.request().postDataJSON() as { origin: string }
    return query.origin === 'TYO'
      ? route.fulfill({ json: reply([outbound()], outboundCheckedAt) })
      : route.fulfill({ status: 502, json: { error: '復路のANA回答を取得できませんでした。空席なしを意味するものではありません。' } })
  })
  const panel = await openSearch(page)
  await panel.getByRole('button', { name: '空席をまとめて照会' }).click()
  await expect(panel.getByRole('status')).toContainText('照会を停止しました')
  await expect(panel.getByRole('status')).toContainText('1 / 2')
  await expect(panel.locator('.live-notice')).toContainText('復路のANA回答を取得できませんでした')
  await expect(panel.locator('.live-empty')).toContainText('取得済み 1件')
  await expect(panel.locator('.live-empty')).toContainText('未取得の便・日付は未確認')
  await expect(panel.locator('.live-empty')).not.toContainText('希望人数を満たす組み合わせがありません')
  await panel.getByRole('checkbox', { name: '残席不足・0席も表示' }).check()
  await expect(panel.locator('tbody tr')).toHaveCount(0)
  await expect(panel.getByRole('button', { name: '空席CSV' })).toBeDisabled()
})
