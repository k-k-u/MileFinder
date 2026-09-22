import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import cloudWorker from './cloudWorker'
import { searchAnaAvailability } from './anaProvider'
import { addDays } from '../src/lib/search'
import type { CloudEnv, D1Database, D1Result, D1Statement } from './cloudTypes'
import type { MemberQuery } from '../src/lib/anaMember'

vi.mock('./anaProvider', () => ({ searchAnaAvailability: vi.fn() }))

/** SQLを模倣せず、実SQLiteへD1の使用部分だけを接続する。 */
class SqliteStatement implements D1Statement {
  constructor(readonly db: DatabaseSync, readonly sql: string, readonly values: unknown[] = []) {}
  bind(...values: unknown[]) { return new SqliteStatement(this.db, this.sql, values) }
  async first<T>(column?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.values as (string | number | null)[])
    return row ? (column ? row[column] : row) as T : null
  }
  execute(): D1Result {
    const result = this.db.prepare(this.sql).run(...this.values as (string | number | null)[])
    return { success: true, meta: { changes: Number(result.changes) } }
  }
  async run() { return this.execute() }
}
class SqliteD1 implements D1Database {
  readonly raw = new DatabaseSync(':memory:')
  prepare(sql: string) { return new SqliteStatement(this.raw, sql) }
  async batch(statements: D1Statement[]) {
    this.raw.exec('BEGIN')
    try {
      const results = statements.map(statement => (statement as SqliteStatement).execute())
      this.raw.exec('COMMIT')
      return results
    } catch (error) { this.raw.exec('ROLLBACK'); throw error }
  }
}

const SITE = 'https://milefinder-ana-awards.raisin7524.chatgpt.site'
const LOCAL = 'http://127.0.0.1:5173'
const SECRET = 'test-worker-secret-is-not-an-ana-credential'
const QUERY: MemberQuery = { origin: 'TYO', destination: 'HNL', departureDate: '2026-10-01', returnDate: '2026-10-05', cabin: 'economy', passengers: 1 }
let db: SqliteD1, env: CloudEnv

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-23T03:00:00.000Z'))
  db = new SqliteD1()
  env = { DB: db, MEMBER_WORKER_TOKEN: SECRET }
  vi.mocked(searchAnaAvailability).mockReset()
})
afterEach(() => { db.raw.close(); vi.useRealTimers(); vi.restoreAllMocks() })

async function call(path: string, method = 'GET', value?: unknown, options: { worker?: boolean; token?: string; origin?: string | null; ip?: string } = {}) {
  const headers = new Headers({ 'cf-connecting-ip': options.ip || '192.0.2.1' })
  const origin = options.origin === undefined ? options.worker ? LOCAL : SITE : options.origin
  if (origin !== null) headers.set('origin', origin)
  if (options.worker || options.token) headers.set('authorization', `Bearer ${options.token ?? SECRET}`)
  if (value !== undefined) headers.set('content-type', 'application/json')
  const response = await cloudWorker.fetch(new Request(SITE + path, { method, headers, ...(value === undefined ? {} : { body: JSON.stringify(value) }) }), env)
  const data = await response.json() as Record<string, any>
  return { response, data }
}
async function heartbeat(query: MemberQuery | null = QUERY) { return call('/api/worker/heartbeat', 'POST', { query }, { worker: true }) }
async function create(query = QUERY, ip?: string) { return call('/api/member/jobs', 'POST', { query }, { ip }) }
async function claim() { return call('/api/worker/claim', 'POST', {}, { worker: true }) }
async function poll(job: { id: string; accessToken: string }) { return call(`/api/member/jobs/${job.id}`, 'GET', undefined, { token: job.accessToken }) }
function result(query = QUERY) {
  return {
    query, source: 'ana-member', partial: true, checkedAt: new Date().toISOString(),
    itineraries: [{
      outbound: [{ flightNumber: 'NH186', origin: 'HND', destination: 'HNL', date: query.departureDate, bookingClass: 'X' }],
      inbound: [{ flightNumber: 'NH185', origin: 'HNL', destination: 'HND', date: query.returnDate, bookingClass: 'X' }],
      outboundSeats: 2, inboundSeats: 0, totalMiles: 40000, totalCashJpy: 90250,
    }],
  }
}
async function upload(job: { id: string; leaseId: string }, value: unknown) { return call(`/api/worker/jobs/${job.id}/result`, 'POST', { leaseId: job.leaseId, result: value }, { worker: true }) }

describe('公開APIと管理workerの境界', () => {
  it('workerのOrigin・Bearerと公開POSTの同一Originを必須にする', async () => {
    expect((await heartbeat()).response.status).toBe(200)
    expect((await call('/api/worker/heartbeat', 'POST', { query: QUERY }, { worker: true, origin: SITE })).response.status).toBe(403)
    expect((await call('/api/worker/heartbeat', 'POST', { query: QUERY }, { worker: true, token: 'wrong' })).response.status).toBe(401)
    expect((await call('/api/worker/heartbeat', 'POST', { query: QUERY }, { origin: LOCAL })).response.status).toBe(401)
    for (const origin of [null, 'https://untrusted.example']) expect((await call('/api/member/jobs', 'POST', { query: QUERY }, { origin })).response.status).toBe(403)
    expect((await heartbeat()).response.headers.get('access-control-allow-origin')).toBe(LOCAL)
    const preflight = await cloudWorker.fetch(new Request(SITE + '/api/worker/claim', { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } }), env)
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
    expect(preflight.headers.has('access-control-allow-credentials')).toBe(false)
  })

  it('未接続・接続中の路線・厳密な6項目と期間を区別する', async () => {
    expect((await call('/api/member/status')).data).toEqual({ connected: false, query: null, busy: false })
    expect((await create()).data.error).toBe('worker_offline')
    await heartbeat()
    expect((await call('/api/member/status')).data).toEqual({ connected: true, query: QUERY, busy: false })
    expect((await create({ ...QUERY, destination: 'LAX' })).response.status).toBe(409)
    for (const query of [{ ...QUERY, extra: true }, { ...QUERY, cabin: 'business' }, { ...QUERY, passengers: 10 }, { ...QUERY, departureDate: '2026-09-26' }, { ...QUERY, returnDate: '2027-09-14' }, { ...QUERY, origin: 'HNL', destination: 'TYO' }]) {
      expect((await call('/api/member/jobs', 'POST', { query })).response.status).toBe(400)
    }
  })

  it('状態の保存失敗でもDB例外や認証情報を応答へ出さない', async () => {
    const broken = { prepare() { throw new Error('private-token-and-query') } } as unknown as D1Database
    const response = await cloudWorker.fetch(new Request(SITE + '/api/member/status'), { ...env, DB: broken })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'service_unavailable' })
  })
})

describe('D1の永続ジョブ・lease・安全な結果', () => {
  it('同条件を共有してもread tokenを分け、tokenなし・他tokenの閲覧を拒否する', async () => {
    await heartbeat()
    const a = (await create()).data, b = (await create()).data
    expect(a.id).toBe(b.id)
    expect(a.accessToken).not.toBe(b.accessToken)
    expect((await poll(a as any)).data.status).toBe('queued')
    expect((await call(`/api/member/jobs/${a.id}`)).response.status).toBe(403)
    expect((await call(`/api/member/jobs/${a.id}`, 'GET', undefined, { token: '0'.repeat(64) })).response.status).toBe(403)
    const stored = db.raw.prepare('SELECT token_hash FROM mf_access').all()
    expect(stored).toHaveLength(2)
    expect(JSON.stringify(stored)).not.toContain(a.accessToken)
    expect(JSON.stringify(stored)).not.toContain(b.accessToken)
  })

  it('同時claimでも1件だけを実行し、完了するまで次のjobを渡さない', async () => {
    await heartbeat()
    await create()
    await create({ ...QUERY, departureDate: '2026-10-02' })
    const attempts = await Promise.all(Array.from({ length: 5 }, () => claim()))
    expect(attempts.every(item => item.response.status === 200)).toBe(true)
    const jobs = attempts.map(item => item.data.job).filter(Boolean)
    expect(jobs).toHaveLength(1)
    expect((await claim()).data.job).toBeNull()
    expect((await call('/api/member/status')).data.busy).toBe(true)
    expect((await upload(jobs[0], result(jobs[0].query))).response.status).toBe(200)
    expect((await claim()).data.job).not.toBeNull()
  })

  it('条件・便・料金を再検証し、既知項目と0席・空席待ちだけを返す', async () => {
    await heartbeat()
    const access = (await create()).data
    const job = (await claim()).data.job
    expect((await upload({ ...job, leaseId: crypto.randomUUID() }, result())).response.status).toBe(409)
    expect((await upload(job, result({ ...QUERY, passengers: 2 }))).response.status).toBe(400)
    const bad = result(); bad.itineraries[0].outbound[0].origin = 'KIX'
    expect((await upload(job, bad)).response.status).toBe(400)
    const value = { ...result(), unexpectedCookie: 'never-copy-this', itineraries: [{ ...result().itineraries[0], inboundWaitlist: true, unexpectedName: 'never-copy-this' }] }
    expect((await upload(job, value)).response.status).toBe(200)
    const reply = await poll(access as any)
    expect(reply.data.status).toBe('succeeded')
    expect(reply.data.result.itineraries[0].inboundSeats).toBe(0)
    expect(reply.data.result.itineraries[0].inboundWaitlist).toBe(true)
    expect(reply.data.result.query).toEqual(QUERY)
    expect(JSON.stringify(reply.data)).not.toContain('never-copy-this')
    expect(String(db.raw.prepare('SELECT result_json FROM mf_jobs').get()?.result_json)).not.toContain('never-copy-this')
  })

  it('queued取消は自分の購読だけを外し、runningの処理を中断しない', async () => {
    await heartbeat()
    const a = (await create()).data, b = (await create()).data
    expect((await call(`/api/member/jobs/${a.id}`, 'DELETE', undefined, { token: a.accessToken })).data.status).toBe('cancelled')
    expect((await poll(b as any)).data.status).toBe('queued')
    await claim()
    expect((await call(`/api/member/jobs/${b.id}`, 'DELETE', undefined, { token: b.accessToken })).response.status).toBe(409)
    expect((await poll(b as any)).data.status).toBe('running')
    const c = (await create({ ...QUERY, departureDate: '2026-10-02' })).data
    expect((await call(`/api/member/jobs/${c.id}`, 'DELETE', undefined, { token: c.accessToken })).data.status).toBe('cancelled')
    expect(db.raw.prepare('SELECT status FROM mf_jobs WHERE id=?').get(c.id)?.status).toBe('cancelled')
  })

  it('heartbeat15秒とlease90秒を区別し、期限切れを自動再試行しない', async () => {
    await heartbeat()
    const access = (await create()).data, job = (await claim()).data.job
    vi.setSystemTime(Date.now() + 15_000)
    expect((await call('/api/member/status')).data.connected).toBe(true)
    vi.setSystemTime(Date.now() + 1)
    expect((await call('/api/member/status')).data.connected).toBe(false)
    expect((await create()).response.status).toBe(503)
    vi.setSystemTime(Date.now() + 75_000)
    expect((await upload(job, result())).data.error).toBe('lease_expired')
    expect((await poll(access as any)).data).toMatchObject({ status: 'failed', error: 'timeout' })
    await heartbeat()
    expect((await claim()).data.job).toBeNull()
  })

  it('workerの固定errorを保存して接続を解除し、raw errorは受け付けない', async () => {
    await heartbeat()
    const access = (await create()).data, job = (await claim()).data.job
    expect((await call(`/api/worker/jobs/${job.id}/result`, 'POST', { leaseId: job.leaseId, error: 'private detail' }, { worker: true })).response.status).toBe(400)
    expect((await call(`/api/worker/jobs/${job.id}/result`, 'POST', { leaseId: job.leaseId, error: 'captcha' }, { worker: true })).response.status).toBe(200)
    expect((await poll(access as any)).data).toMatchObject({ status: 'failed', error: 'captcha' })
    expect((await call('/api/member/status')).data.connected).toBe(false)
  })

  it('既存結果は確認時刻から2分だけ共有し、job10分・保存30分の期限を守る', async () => {
    await heartbeat()
    const access = (await create()).data, job = (await claim()).data.job
    await upload(job, result())
    expect((await create()).data.id).toBe(access.id)
    vi.setSystemTime(Date.now() + 120_001)
    await heartbeat()
    expect((await create()).data.id).not.toBe(access.id)
    vi.setSystemTime(new Date('2026-09-23T03:10:00.001Z'))
    expect((await poll(access as any)).response.status).toBe(503)
    expect((await poll(access as any)).data.error).toBe('expired')
    vi.setSystemTime(new Date('2026-09-23T03:30:00.001Z'))
    expect((await poll(access as any)).response.status).toBe(403)
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM mf_jobs WHERE id=?').get(access.id)?.count).toBe(0)
  })

  it('8件のqueue上限と利用者ごとの作成回数制限をD1で保つ', async () => {
    await heartbeat()
    for (let i = 0; i < 8; i++) expect((await create({ ...QUERY, departureDate: addDays(QUERY.departureDate, i), returnDate: addDays(QUERY.returnDate, i) })).response.status).toBe(202)
    expect((await create({ ...QUERY, departureDate: '2026-10-09', returnDate: '2026-10-13' })).data.error).toBe('queue_full')
    for (let i = 0; i < 5; i++) expect((await create()).response.status).toBe(202)
    expect((await create()).data.error).toBe('rate_limited')
  })
})

describe('公開匿名API', () => {
  it('失敗診断は固定stageとHTTP番号だけとし、未知の外部文字列をログにも返さない', async () => {
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
    const query = { origin: 'TYO', destination: 'HNL', dateFrom: '2026-10-01', dateTo: '2026-10-01' }
    vi.mocked(searchAnaAvailability).mockImplementation(async (_query, _signal, progress) => {
      progress?.({ stage: '公開設定の取得', pages: 0 })
      throw new Error('ANAチャットの公開設定に失敗しました（HTTP 403）。')
    })
    expect((await call('/api/ana/availability', 'POST', query)).response.status).toBe(502)
    expect(diagnostic).toHaveBeenLastCalledWith('ana_public_failure', { stage: 'configuration', upstreamStatus: 403 })
    vi.mocked(searchAnaAvailability).mockImplementation(async (_query, _signal, progress) => {
      progress?.({ stage: 'private external value', pages: 0 })
      throw new Error('private external value')
    })
    const failed = await call('/api/ana/availability', 'POST', query)
    expect(diagnostic).toHaveBeenLastCalledWith('ana_public_failure', { stage: 'unknown', upstreamStatus: null })
    expect(JSON.stringify(failed.data) + JSON.stringify(diagnostic.mock.calls)).not.toContain('private external value')
  })

  it('共有validatorとD1のlockでprovider呼出を1件に制限する', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let finish!: (value: Awaited<ReturnType<typeof searchAnaAvailability>>) => void
    vi.mocked(searchAnaAvailability).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const query = { origin: 'TYO', destination: 'HNL', dateFrom: '2026-10-01', dateTo: '2026-10-02' }
    expect((await call('/api/ana/availability', 'POST', { ...query, extra: true })).response.status).toBe(400)
    const first = call('/api/ana/availability', 'POST', query)
    await vi.waitFor(() => expect(searchAnaAvailability).toHaveBeenCalledTimes(1))
    expect((await call('/api/ana/availability', 'POST', query)).response.status).toBe(429)
    finish({ offers: [], checkedAt: new Date().toISOString(), source: 'ana-public-chat', accountScope: 'anonymous', partial: true, notes: [] })
    expect((await first).response.status).toBe(200)
    vi.mocked(searchAnaAvailability).mockRejectedValue(new Error('private upstream data'))
    const failed = await call('/api/ana/availability', 'POST', query)
    expect(failed.response.status).toBe(502)
    expect(JSON.stringify(failed.data)).not.toContain('private upstream data')
  })
})
