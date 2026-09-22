import { test, expect, type Page, type Request } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import type { AnaChatOffer } from '../src/lib/anaChat'
import { addDays, type SearchFilters } from '../src/lib/search'

const today = '2026-09-22'
const departure = addDays(today, 30)
const endpoint = '**/api/ana/availability'
const checkedAt = '2026-09-22T03:00:00.000Z'

function offer(overrides: Partial<AnaChatOffer> = {}): AnaChatOffer {
  return {
    flightNumber: 'NH186', originLabel: '東京(羽田)', destinationLabel: 'ホノルル(オアフ島)',
    date: departure, time: '21:30', cabin: 'economy', seats: 3,
    source: 'ana-public-chat', accountScope: 'anonymous', ...overrides,
  }
}

function reply(offers: AnaChatOffer[], partial = false) {
  return { offers, checkedAt, partial, notes: [], source: 'ana-public-chat', accountScope: 'anonymous' }
}

async function openSearch(page: Page, overrides: Partial<SearchFilters> = {}) {
  const filters: SearchFilters = {
    kind: 'international', origin: 'HND', region: 'ハワイ',
    dateFrom: departure, dateTo: departure, tripType: 'oneway', nights: 3,
    cabin: 'economy', passengers: 2, budget: 60_000,
    ...overrides,
  }
  await page.goto(`/?search=${encodeURIComponent(JSON.stringify(filters))}`)
  await expect(page.getByRole('region', { name: '実際の空席を一括照会' })).toBeVisible()
}

async function readAvailabilityCsv(page: Page): Promise<string> {
  const downloading = page.waitForEvent('download')
  await page.getByRole('button', { name: '空席CSV', exact: true }).click()
  const download = await downloading
  expect(download.suggestedFilename()).toBe('milefinder-availability.csv')
  const csv = await readFile((await download.path())!, 'utf8')
  expect(csv.startsWith('\uFEFF')).toBe(true)
  return csv
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(checkedAt))
  // 新しいANAエンドポイントが追加されても、この試験から実サービスへ照会しない。
  await page.route('**/api/ana/**', route => route.fulfill({
    status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'テスト用stubが未定義です。' }),
  }))
})

test('席数・人数分のマイル・確認時刻を表示し、0席と残席不足を切り替える', async ({ page }) => {
  await page.route(endpoint, async route => {
    expect(route.request().method()).toBe('POST')
    expect(route.request().postDataJSON()).toEqual({ origin: 'HND', destination: 'HNL', dateFrom: departure, dateTo: departure })
    await route.fulfill({ json: reply([
      offer(), offer({ flightNumber: 'NH182', seats: 1 }), offer({ flightNumber: 'NH184', seats: 0 }),
    ], true) })
  })
  await openSearch(page)
  const panel = page.getByRole('region', { name: '実際の空席を一括照会' })
  await panel.getByRole('button', { name: '空席をまとめて照会' }).click()
  await expect(panel.getByRole('status')).toContainText('照会が終了しました')
  await expect(panel.locator('.live-results-top')).toContainText('人数を満たす空席 1件')
  await expect(panel.locator('tbody tr')).toHaveCount(1)
  await expect(panel.locator('tbody tr')).toContainText('NH186')
  await expect(panel.locator('tbody tr')).toContainText('3席')
  await expect(panel.locator('tbody tr')).toContainText('40,000')
  await expect(panel.locator('tbody tr')).toContainText('9/22 12:00')
  await expect(panel.locator('.live-notice')).toContainText('表示されない便・日付の空席は未確認')
  await panel.getByRole('checkbox', { name: '残席不足・0席も表示' }).check()
  await expect(panel.locator('tbody tr')).toHaveCount(3)
  await expect(panel.locator('.seats-empty')).toHaveText(['1席', '0席'])
  const csv = await readAvailabilityCsv(page)
  expect(csv.trimEnd().slice(1).split('\r\n')).toHaveLength(4)
  expect(csv).toContain('"回答席数","希望人数","人数を満たす"')
  expect(csv).toContain('"3","2","はい","40000"')
  expect(csv).toContain('"1","2","いいえ","40000"')
  expect(csv).toContain('"0","2","いいえ","40000"')
  expect(csv).toContain(`"${checkedAt}","ANA公式チャット","未ログイン"`)
  await panel.getByRole('checkbox', { name: '残席不足・0席も表示' }).uncheck()
  await expect(panel.locator('tbody tr')).toHaveCount(1)
})

test('方面を限定しない検索でも、空席照会先以外の回答を一覧とCSVへ含めない', async ({ page }) => {
  await page.route(endpoint, async route => {
    expect(route.request().postDataJSON()).toEqual({ origin: 'HND', destination: 'HNL', dateFrom: departure, dateTo: departure })
    await route.fulfill({ json: reply([
      offer(), offer({ flightNumber: 'NH106', destinationLabel: 'ロサンゼルス' }),
    ]) })
  })
  await openSearch(page, { region: 'all' })
  const panel = page.getByRole('region', { name: '実際の空席を一括照会' })
  const destinations = panel.getByLabel('空席照会の行き先')
  // LAXも予算・人数・日付に合う元候補に含まれる状態で、照会だけをHNLへ限定する。
  await expect(destinations.locator('option[value="LAX"]')).toHaveCount(1)
  await destinations.selectOption('HNL')
  await panel.getByRole('button', { name: '空席をまとめて照会' }).click()
  await expect(panel.getByRole('status')).toContainText('照会が終了しました')
  await expect(panel.locator('tbody tr')).toHaveCount(1)
  await expect(panel.locator('tbody tr')).toContainText('NH186')
  await expect(panel.locator('tbody')).not.toContainText('NH106')
  const csv = await readAvailabilityCsv(page)
  expect(csv.trimEnd().slice(1).split('\r\n')).toHaveLength(2)
  expect(csv).toContain('"NH186"')
  expect(csv).not.toContain('NH106')
  expect(csv).not.toContain('ロサンゼルス')
})

test('別クラス・期間外・別空港・他社便の空席を現在の条件へ結合しない', async ({ page }) => {
  await page.route(endpoint, route => route.fulfill({ json: reply([
    offer(),
    offer({ flightNumber: 'NH801', cabin: 'business' }),
    offer({ flightNumber: 'NH802', date: addDays(departure, 1) }),
    offer({ flightNumber: 'NH803', originLabel: '東京(成田)' }),
    offer({ flightNumber: 'NH804', destinationLabel: 'ロサンゼルス' }),
    offer({ flightNumber: 'UA805' }),
    offer({ flightNumber: 'NH806', originLabel: '東京' }),
  ]) }))
  await openSearch(page)
  const panel = page.getByRole('region', { name: '実際の空席を一括照会' })
  await panel.getByRole('button', { name: '空席をまとめて照会' }).click()
  await expect(panel.getByRole('status')).toContainText('照会が終了しました')
  await panel.getByRole('checkbox', { name: '残席不足・0席も表示' }).check()
  await expect(panel.locator('tbody tr')).toHaveCount(1)
  await expect(panel.locator('tbody tr')).toContainText('NH186')
  await expect(panel.locator('tbody')).not.toContainText(/NH80[1-6]|UA805/)
})

test('再照会と新条件で表示をリセットし、進行中の旧照会を中止する', async ({ page }) => {
  let calls = 0
  let heldRequest: Request | undefined
  let releaseHeld!: () => void
  const held = new Promise<void>(resolve => { releaseHeld = resolve })
  await page.route(endpoint, async route => {
    calls += 1
    if (calls === 2) {
      heldRequest = route.request()
      await held
      // 中止した応答が遅れて届いても、新条件の表示に入らないことを確認する。
      await route.fulfill({ json: reply([offer({ flightNumber: 'NH999' })]) }).catch(() => {})
      return
    }
    const query = route.request().postDataJSON() as { dateFrom: string }
    await route.fulfill({ json: reply([offer({ flightNumber: calls === 1 ? 'NH186' : 'NH188', date: query.dateFrom })]) })
  })
  await openSearch(page)
  const panel = page.getByRole('region', { name: '実際の空席を一括照会' })
  await panel.getByRole('button', { name: '空席をまとめて照会' }).click()
  await expect(panel.locator('tbody tr')).toContainText('NH186')
  await expect(panel.getByRole('status')).toContainText('照会が終了しました')
  await panel.getByRole('button', { name: '空席をまとめて照会' }).click()
  await expect.poll(() => calls).toBe(2)
  await expect(panel.getByRole('button', { name: '照会を中止' })).toBeVisible()
  await expect(panel.locator('tbody tr')).toHaveCount(0)

  const nextDate = addDays(departure, 1)
  await page.getByLabel('出発日の開始').fill(nextDate)
  await page.getByLabel('出発日の終了').fill(nextDate)
  await page.getByLabel('人数', { exact: true }).selectOption('3')
  await page.getByRole('button', { name: 'この条件で探す' }).click()
  await expect(panel.getByRole('button', { name: '空席をまとめて照会' })).toBeEnabled()
  await expect(panel.getByRole('status')).toHaveCount(0)
  await expect(panel.locator('tbody tr')).toHaveCount(0)
  releaseHeld()
  await expect.poll(() => heldRequest?.failure()?.errorText ?? '').toContain('ERR_ABORTED')

  await panel.getByRole('button', { name: '空席をまとめて照会' }).click()
  await expect(panel.getByRole('status')).toContainText('照会が終了しました')
  await expect(panel.locator('tbody tr')).toHaveCount(1)
  await expect(panel.locator('tbody tr')).toContainText('NH188')
  await expect(panel.locator('tbody tr')).toContainText(nextDate)
  await expect(panel.locator('tbody tr')).toContainText('60,000')
  await expect(panel).not.toContainText('NH999')
  expect(calls).toBe(3)
})

test('HTTP 502を取得失敗として示し、空席なしと断定しない', async ({ page }) => {
  await page.route(endpoint, route => route.fulfill({
    status: 502, contentType: 'application/json',
    body: JSON.stringify({ error: 'ANAの空席回答を確認できませんでした。再度照会してください。' }),
  }))
  await openSearch(page)
  const panel = page.getByRole('region', { name: '実際の空席を一括照会' })
  await panel.getByRole('button', { name: '空席をまとめて照会' }).click()
  await expect(panel.getByRole('status')).toContainText('照会を停止しました')
  await expect(panel.locator('.live-notice')).toContainText('ANAの空席回答を確認できませんでした。')
  await expect(panel.locator('.live-empty')).toHaveText('条件に対応する空席回答をまだ取得できていません。')
  await expect(panel).not.toContainText('希望人数を満たす空席がありません')
  await expect(panel.getByRole('button', { name: '空席CSV' })).toBeDisabled()
  await expect(panel.getByRole('button', { name: '空席をまとめて照会' })).toBeEnabled()
})
