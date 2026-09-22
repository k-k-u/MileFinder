import { searchAnaAvailability } from './anaProvider'
import { validQuery } from './availabilityQuery'
import { readMemberRows, validMemberQuery } from '../src/lib/memberResults'
import { addDays, todayInTokyo } from '../src/lib/search'
import type { MemberItinerary, MemberQuery } from '../src/lib/anaMember'
import type { CloudEnv, D1Database } from './cloudTypes'

const LOCAL_ORIGINS = new Set(['http://127.0.0.1:5173', 'http://localhost:5173'])
const HEARTBEAT_MS = 15_000
const LEASE_MS = 90_000
const JOB_MS = 10 * 60_000
const RETENTION_MS = 30 * 60_000
const CACHE_MS = 2 * 60_000
const QUEUE_LIMIT = 8
const WORKER_ERRORS = new Set(['captcha', 'login', 'unsupported', 'failed', 'timeout', 'cancelled'])
const ANA_STAGES = new Map([
  ['公開設定の取得', 'configuration'], ['初期JWT認証', 'initial_auth'], ['Kore認証', 'kore_auth'],
  ['RTM接続準備', 'rtm'], ['WebSocket接続', 'websocket'], ['チャットの開始通知待ち', 'ready'],
  ['ログイン確認', 'login_prompt'], ['検索方法の選択', 'method'], ['直行便の指定', 'direct'],
  ['特典航空券の種類', 'award_type'], ['出発日の入力', 'date'], ['出発日の確認', 'date_confirm'],
  ['出発地の入力', 'origin'], ['到着地の入力', 'destination'], ['搭乗クラスの選択', 'cabin'],
  ['検索条件の最終確認', 'confirmation'], ['空席結果の取得', 'results'],
])
const initialized = new WeakMap<D1Database, Promise<void>>()

type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
interface Job {
  id: string; query_json: string; query_key: string; origin: string; destination: string
  status: JobState; created_at: number; expires_at: number; lease_id: string | null
  lease_expires_at: number | null; result_json: string | null; checked_at: number | null; error_code: string | null
}
interface WorkerState { query_json: string | null; last_heartbeat: number }
interface MemberResult { query: MemberQuery; itineraries: MemberItinerary[]; checkedAt: string; source: 'ana-member'; partial: true }
class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}
function reject(status: number, code: string): never { throw new ApiError(status, code) }
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject(400, 'invalid_body')
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, names: string[]) {
  return Object.keys(value).sort().join(',') === [...names].sort().join(',')
}
async function body(request: Request, limit = 4096): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) reject(415, 'json_required')
  if (Number(request.headers.get('content-length') || 0) > limit) reject(413, 'body_too_large')
  const reader = request.body?.getReader()
  if (!reader) reject(400, 'invalid_body')
  const decoder = new TextDecoder()
  let text = '', size = 0
  while (true) {
    const part = await reader.read()
    if (part.done) break
    size += part.value.byteLength
    if (size > limit) { await reader.cancel(); reject(413, 'body_too_large') }
    text += decoder.decode(part.value, { stream: true })
  }
  try { return object(JSON.parse(text + decoder.decode())) } catch (error) {
    if (error instanceof ApiError) throw error
    return reject(400, 'invalid_body')
  }
}
async function hash(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, '0')).join('')
}
function token() { return crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '') }
function bearer(request: Request) {
  const match = /^Bearer ([^\s]{1,1024})$/.exec(request.headers.get('authorization') || '')
  return match?.[1] || ''
}
async function workerAuth(request: Request, env: CloudEnv) {
  if (typeof env.MEMBER_WORKER_TOKEN !== 'string' || env.MEMBER_WORKER_TOKEN.length < 32) reject(503, 'worker_unconfigured')
  const received = bearer(request)
  if (!received) reject(401, 'unauthorized')
  const [actual, expected] = await Promise.all([hash(received), hash(env.MEMBER_WORKER_TOKEN)])
  let different = 0
  for (let i = 0; i < actual.length; i++) different |= actual.charCodeAt(i) ^ expected.charCodeAt(i)
  if (different) reject(401, 'unauthorized')
}

async function initialize(db: D1Database) {
  let pending = initialized.get(db)
  if (!pending) {
    pending = db.batch([
      db.prepare('CREATE TABLE IF NOT EXISTS mf_worker (id INTEGER PRIMARY KEY CHECK(id=1), query_json TEXT, last_heartbeat INTEGER NOT NULL DEFAULT 0)'),
      db.prepare('INSERT OR IGNORE INTO mf_worker(id,last_heartbeat) VALUES(1,0)'),
      db.prepare("CREATE TABLE IF NOT EXISTS mf_jobs (id TEXT PRIMARY KEY, query_json TEXT NOT NULL, query_key TEXT NOT NULL, origin TEXT NOT NULL, destination TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, lease_id TEXT, lease_expires_at INTEGER, result_json TEXT, checked_at INTEGER, error_code TEXT)"),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS mf_single_running ON mf_jobs(status) WHERE status='running'"),
      db.prepare('CREATE INDEX IF NOT EXISTS mf_job_lookup ON mf_jobs(query_key,status,checked_at)'),
      db.prepare('CREATE TABLE IF NOT EXISTS mf_access (token_hash TEXT PRIMARY KEY, job_id TEXT NOT NULL, expires_at INTEGER NOT NULL)'),
      db.prepare('CREATE TABLE IF NOT EXISTS mf_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL)'),
      db.prepare('CREATE TABLE IF NOT EXISTS mf_locks (name TEXT PRIMARY KEY, lease_id TEXT NOT NULL, expires_at INTEGER NOT NULL)'),
    ]).then(() => undefined).catch(error => { initialized.delete(db); throw error })
    initialized.set(db, pending)
  }
  await pending
}
async function expire(db: D1Database, now: number) {
  await db.batch([
    // リース切れの処理がANA側で終わった保証はない。再接続されるまで新しい照会を止める。
    db.prepare("UPDATE mf_worker SET query_json=NULL,last_heartbeat=0 WHERE id=1 AND EXISTS(SELECT 1 FROM mf_jobs WHERE status='running' AND lease_expires_at<=?)").bind(now),
    db.prepare("UPDATE mf_jobs SET status='failed',error_code='timeout',lease_id=NULL WHERE status='running' AND lease_expires_at<=?").bind(now),
    db.prepare("UPDATE mf_jobs SET status='failed',error_code='expired' WHERE status='queued' AND expires_at<=?").bind(now),
    db.prepare('DELETE FROM mf_access WHERE expires_at<=?').bind(now),
    db.prepare('DELETE FROM mf_jobs WHERE created_at<=?').bind(now - RETENTION_MS),
    db.prepare('DELETE FROM mf_limits WHERE reset_at<=?').bind(now - 60_000),
    db.prepare('DELETE FROM mf_locks WHERE expires_at<=?').bind(now),
  ])
}
function memberQuery(value: unknown): MemberQuery {
  const q = object(value)
  if (!keys(q, ['origin', 'destination', 'departureDate', 'returnDate', 'cabin', 'passengers']) || !validMemberQuery(q)) reject(400, 'invalid_query')
  const today = todayInTokyo()
  if (q.departureDate < addDays(today, 4) || q.returnDate > addDays(today, 355)) reject(400, 'invalid_query')
  return { origin: q.origin, destination: q.destination, departureDate: q.departureDate, returnDate: q.returnDate, cabin: q.cabin, passengers: q.passengers }
}
function storedQuery(text: string | null): MemberQuery | null {
  if (!text) return null
  try { return memberQuery(JSON.parse(text)) } catch { return null }
}
async function status(db: D1Database, now: number) {
  const [state, active] = await Promise.all([
    db.prepare('SELECT query_json,last_heartbeat FROM mf_worker WHERE id=1').first<WorkerState>(),
    db.prepare("SELECT id FROM mf_jobs WHERE status='running' AND lease_expires_at>?").bind(now).first<{ id: string }>(),
  ])
  const query = storedQuery(state?.query_json ?? null)
  const connected = !!query && !!state && state.last_heartbeat >= now - HEARTBEAT_MS
  return { connected, query: connected ? query : null, busy: !!active }
}
function sameRoute(a: MemberQuery, b: MemberQuery) { return a.origin === b.origin && a.destination === b.destination && a.cabin === b.cabin }
async function rate(db: D1Database, key: string, limit: number, now: number) {
  const row = await db.prepare('INSERT INTO mf_limits(key,count,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN reset_at<=? THEN 1 ELSE count+1 END,reset_at=CASE WHEN reset_at<=? THEN ? ELSE reset_at END RETURNING count').bind(key, now + 60_000, now, now, now + 60_000).first<{ count: number }>()
  if (!row || row.count > limit) reject(429, 'rate_limited')
}
async function requestLimits(request: Request, db: D1Database, kind: string, now: number) {
  const identity = await hash(request.headers.get('cf-connecting-ip') || 'unidentified')
  await rate(db, `${kind}:client:${identity}`, kind === 'member' ? 14 : 4, now)
  await rate(db, `${kind}:global`, kind === 'member' ? 30 : 12, now)
}
function safeResult(value: unknown, query: MemberQuery, now: number): MemberResult {
  let rows
  try { rows = readMemberRows(value, query) } catch { return reject(400, 'invalid_result') }
  const checkedAt = rows[0].checkedAt
  const checked = Date.parse(checkedAt)
  if (checked > now + 30_000 || checked < now - RETENTION_MS) reject(400, 'invalid_result')
  return {
    query,
    itineraries: rows.map(row => ({ outbound: row.outbound, inbound: row.inbound, outboundSeats: row.outboundSeats, inboundSeats: row.inboundSeats, totalMiles: row.totalMiles, totalCashJpy: row.totalCashJpy, ...(row.outboundWaitlist === undefined ? {} : { outboundWaitlist: row.outboundWaitlist }), ...(row.inboundWaitlist === undefined ? {} : { inboundWaitlist: row.inboundWaitlist }) })),
    checkedAt, source: 'ana-member', partial: true,
  }
}
function jobView(job: Job) {
  return { id: job.id, status: job.status, query: JSON.parse(job.query_json) as MemberQuery, createdAt: new Date(job.created_at).toISOString(), expiresAt: new Date(job.expires_at).toISOString(), ...(job.result_json ? { result: JSON.parse(job.result_json) as MemberResult } : {}), ...(job.error_code ? { error: job.error_code } : {}) }
}
async function readJob(request: Request, db: D1Database, id: string, now: number) {
  const access = bearer(request)
  if (!/^[a-f0-9]{64}$/.test(access)) reject(403, 'forbidden')
  const job = await db.prepare('SELECT j.* FROM mf_jobs j JOIN mf_access a ON a.job_id=j.id WHERE j.id=? AND a.token_hash=? AND a.expires_at>?').bind(id, await hash(access), now).first<Job>()
  if (!job) reject(403, 'forbidden')
  return job
}

async function memberApi(request: Request, db: D1Database, path: string, now: number) {
  if (path === '/api/member/status' && request.method === 'GET') return json(await status(db, now))
  if (path === '/api/member/jobs' && request.method === 'POST') {
    const data = await body(request)
    if (!keys(data, ['query'])) reject(400, 'invalid_body')
    const query = memberQuery(data.query)
    await requestLimits(request, db, 'member', now)
    const current = await status(db, now)
    if (!current.connected || !current.query) reject(503, 'worker_offline')
    if (!sameRoute(query, current.query)) reject(409, 'route_unavailable')
    const encoded = JSON.stringify(query), queryKey = await hash(encoded), id = crypto.randomUUID()
    const existingSql = "SELECT * FROM mf_jobs WHERE query_key=? AND expires_at>? AND (status IN ('queued','running') OR status='succeeded' AND checked_at>?) ORDER BY created_at DESC LIMIT 1"
    let job = await db.prepare(existingSql).bind(queryKey, now, now - CACHE_MS).first<Job>()
    if (!job) {
      job = await db.prepare("INSERT INTO mf_jobs(id,query_json,query_key,origin,destination,status,created_at,expires_at) SELECT ?,?,?,?,?, 'queued',?,? WHERE (SELECT COUNT(*) FROM mf_jobs WHERE status IN ('queued','running'))<? AND NOT EXISTS(SELECT 1 FROM mf_jobs WHERE query_key=? AND expires_at>? AND (status IN ('queued','running') OR status='succeeded' AND checked_at>?)) RETURNING *")
        .bind(id, encoded, queryKey, query.origin, query.destination, now, now + JOB_MS, QUEUE_LIMIT, queryKey, now, now - CACHE_MS).first<Job>()
      if (!job) job = await db.prepare(existingSql).bind(queryKey, now, now - CACHE_MS).first<Job>()
      if (!job) reject(429, 'queue_full')
    }
    const accessToken = token()
    await db.prepare('INSERT INTO mf_access(token_hash,job_id,expires_at) VALUES(?,?,?)').bind(await hash(accessToken), job.id, job.created_at + RETENTION_MS).run()
    return json({ id: job.id, accessToken, status: job.status }, 202)
  }
  const match = /^\/api\/member\/jobs\/([0-9a-f-]{36})$/.exec(path)
  if (match && ['GET', 'DELETE'].includes(request.method)) {
    let job = await readJob(request, db, match[1], now)
    if (job.expires_at <= now) return json({ ...jobView(job), error: 'expired' }, 503)
    if (request.method === 'DELETE') {
      // 同条件を共有する他の利用者のジョブまで取り消さない。
      const changed = await db.batch([
        db.prepare("DELETE FROM mf_access WHERE job_id=? AND token_hash=? AND EXISTS(SELECT 1 FROM mf_jobs WHERE id=? AND status='queued')").bind(job.id, await hash(bearer(request)), job.id),
        db.prepare("UPDATE mf_jobs SET status='cancelled',error_code='cancelled' WHERE id=? AND status='queued' AND NOT EXISTS(SELECT 1 FROM mf_access WHERE job_id=?)").bind(job.id, job.id),
      ])
      if (!changed[0].meta.changes) reject(409, 'already_running')
      job = { ...job, status: 'cancelled', error_code: 'cancelled' }
    }
    return json(jobView(job))
  }
  return reject(404, 'not_found')
}

async function workerApi(request: Request, db: D1Database, path: string, now: number) {
  if (request.method !== 'POST') reject(405, 'method_not_allowed')
  const data = await body(request, path.endsWith('/result') ? 512_000 : 4096)
  if (path === '/api/worker/heartbeat') {
    if (!keys(data, ['query'])) reject(400, 'invalid_body')
    const query = data.query === null ? null : memberQuery(data.query)
    const current = await status(db, now)
    if (query && current.busy && current.query && !sameRoute(query, current.query)) reject(409, 'busy')
    await db.prepare('UPDATE mf_worker SET query_json=?,last_heartbeat=? WHERE id=1').bind(query ? JSON.stringify(query) : null, now).run()
    return json({ ok: true, busy: current.busy })
  }
  if (path === '/api/worker/claim') {
    if (!keys(data, [])) reject(400, 'invalid_body')
    const current = await status(db, now)
    if (!current.connected || !current.query) reject(503, 'worker_offline')
    const leaseId = crypto.randomUUID()
    const job = await db.prepare("UPDATE mf_jobs SET status='running',lease_id=?,lease_expires_at=? WHERE id=(SELECT id FROM mf_jobs WHERE status='queued' AND expires_at>? AND origin=? AND destination=? ORDER BY created_at,id LIMIT 1) AND NOT EXISTS(SELECT 1 FROM mf_jobs WHERE status='running') RETURNING *")
      .bind(leaseId, now + LEASE_MS, now, current.query.origin, current.query.destination).first<Job>()
    return json({ job: job ? { id: job.id, leaseId, query: JSON.parse(job.query_json) as MemberQuery, expiresAt: new Date(now + LEASE_MS).toISOString() } : null })
  }
  const match = /^\/api\/worker\/jobs\/([0-9a-f-]{36})\/result$/.exec(path)
  if (match) {
    if (!(keys(data, ['leaseId', 'result']) || keys(data, ['leaseId', 'error'])) || typeof data.leaseId !== 'string') reject(400, 'invalid_body')
    const job = await db.prepare("SELECT * FROM mf_jobs WHERE id=? AND status='running' AND lease_id=? AND lease_expires_at>?").bind(match[1], data.leaseId, now).first<Job>()
    if (!job) reject(409, 'lease_expired')
    const query = memberQuery(JSON.parse(job.query_json))
    if (Object.hasOwn(data, 'error')) {
      if (typeof data.error !== 'string' || !WORKER_ERRORS.has(data.error)) reject(400, 'invalid_error')
      await db.batch([
        db.prepare("UPDATE mf_jobs SET status='failed',error_code=?,lease_id=NULL WHERE id=? AND status='running' AND lease_id=?").bind(data.error, job.id, data.leaseId),
        db.prepare('UPDATE mf_worker SET query_json=NULL,last_heartbeat=0 WHERE id=1'),
      ])
    } else {
      const result = safeResult(data.result, query, now)
      const changed = await db.prepare("UPDATE mf_jobs SET status='succeeded',result_json=?,checked_at=?,lease_id=NULL WHERE id=? AND status='running' AND lease_id=? RETURNING id").bind(JSON.stringify(result), Date.parse(result.checkedAt), job.id, data.leaseId).first<{ id: string }>()
      if (!changed) reject(409, 'lease_expired')
    }
    return json({ ok: true })
  }
  return reject(404, 'not_found')
}

async function anonymousApi(request: Request, db: D1Database, now: number) {
  if (request.method !== 'POST') reject(405, 'method_not_allowed')
  const query = await body(request)
  if (!validQuery(query)) reject(400, 'invalid_query')
  await requestLimits(request, db, 'anonymous', now)
  const leaseId = crypto.randomUUID()
  const acquired = await db.prepare("INSERT INTO mf_locks(name,lease_id,expires_at) VALUES('anonymous',?,?) ON CONFLICT(name) DO UPDATE SET lease_id=excluded.lease_id,expires_at=excluded.expires_at WHERE mf_locks.expires_at<=? RETURNING lease_id").bind(leaseId, now + 10 * 60_000, now).first<{ lease_id: string }>()
  if (!acquired) reject(429, 'busy')
  const controller = new AbortController()
  let stage = 'starting'
  let closed = false
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  let releasePromise: Promise<void> | undefined
  let output: ReadableStreamDefaultController<Uint8Array>
  const release = () => {
    clearInterval(heartbeat)
    clearTimeout(timeout)
    request.signal.removeEventListener('abort', abort)
    return releasePromise ??= db.prepare("DELETE FROM mf_locks WHERE name='anonymous' AND lease_id=?")
      .bind(leaseId).run().then(() => undefined)
  }
  const abort = () => {
    if (closed) return
    closed = true
    controller.abort()
    output.error(new Error('空席照会を中止しました。'))
    void release().catch(() => { /* リース期限でも解放される。外部例外は出力しない。 */ })
  }
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      output = streamController
      // JSONの先頭空白はresponse.json()で許容され、待機中の接続維持にも使える。
      output.enqueue(encoder.encode(' '))
      heartbeat = setInterval(() => { if (!closed) output.enqueue(encoder.encode(' ')) }, 15_000)
      timeout = setTimeout(() => controller.abort(), 10 * 60_000)
      request.signal.addEventListener('abort', abort, { once: true })
      if (request.signal.aborted) { abort(); return }
      void (async () => {
        let result: unknown
        try {
          result = await searchAnaAvailability(query, controller.signal, progress => { stage = ANA_STAGES.get(progress.stage) || 'unknown' })
        } catch (error) {
          if (closed) return
          // 固定段階とHTTP番号だけを記録する。外部本文・URL・認証値・検索条件は記録しない。
          const http = error instanceof Error ? /^ANAチャットの(?:公開設定|初期JWT認証|Kore認証|RTM接続準備)に失敗しました（HTTP ([1-5]\d{2})）。$/.exec(error.message) : null
          console.error('ana_public_failure', { stage, upstreamStatus: http ? Number(http[1]) : null })
          result = { error: 'ANAの空席回答を取得できませんでした。空席なしを意味するものではありません。' }
        }
        if (closed) return
        await release()
        if (closed) return
        output.enqueue(encoder.encode(JSON.stringify(result)))
        closed = true
        output.close()
      })().catch(() => {
        if (!closed) { closed = true; output.error(new Error('空席照会を完了できませんでした。')) }
        controller.abort()
        void release().catch(() => { /* 外部例外は出力しない。 */ })
      })
    },
    async cancel() {
      closed = true
      controller.abort()
      await release()
    },
  })
  return new Response(stream, { headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, no-transform',
    'X-Content-Type-Options': 'nosniff',
  } })
}

export default {
  async fetch(request: Request, env: CloudEnv): Promise<Response> {
    const url = new URL(request.url), origin = request.headers.get('origin'), isWorker = url.pathname.startsWith('/api/worker/')
    if (!url.pathname.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(request) : json({ error: 'not_found' }, 404)
    let response: Response
    try {
      if (isWorker) {
        if (!origin || !LOCAL_ORIGINS.has(origin)) reject(403, 'origin_forbidden')
        if (request.method === 'OPTIONS') {
          const method = request.headers.get('access-control-request-method')
          const requested = (request.headers.get('access-control-request-headers') || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean)
          if (method !== 'POST' || requested.some(h => !['authorization', 'content-type'].includes(h))) reject(403, 'origin_forbidden')
          response = new Response(null, { status: 204 })
        } else {
          await workerAuth(request, env)
          if (!env.DB) reject(503, 'storage_unavailable')
          await initialize(env.DB)
          await expire(env.DB, Date.now())
          response = await workerApi(request, env.DB, url.pathname, Date.now())
        }
      } else {
        if (origin && origin !== url.origin || !['GET', 'HEAD'].includes(request.method) && origin !== url.origin) reject(403, 'origin_forbidden')
        if (!env.DB) reject(503, 'storage_unavailable')
        await initialize(env.DB)
        await expire(env.DB, Date.now())
        response = url.pathname === '/api/ana/availability'
          ? await anonymousApi(request, env.DB, Date.now())
          : await memberApi(request, env.DB, url.pathname, Date.now())
      }
    } catch (error) {
      // DB、外部HTTP、認証値を含み得る例外本文は返却・ログ出力しない。
      response = json({ error: error instanceof ApiError ? error.code : 'service_unavailable' }, error instanceof ApiError ? error.status : 503)
    }
    if (isWorker && origin && LOCAL_ORIGINS.has(origin)) {
      response.headers.set('Access-Control-Allow-Origin', origin)
      response.headers.set('Vary', 'Origin')
      response.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
      response.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type')
      response.headers.set('Access-Control-Max-Age', '600')
    }
    return response
  },
}
