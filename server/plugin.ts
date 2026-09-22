import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { createMemberWorkerConfig } from './memberWorkerConfig'
import { searchAnaAvailability } from './anaProvider'
import { validQuery } from './availabilityQuery'
export { validQuery } from './availabilityQuery'

let busy = false
const PATH = '/api/ana/availability'

function json(res: ServerResponse, status: number, value: unknown) {
  if (res.destroyed) return
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

async function middleware(req: IncomingMessage, res: ServerResponse, next: () => void) {
  if (req.url?.split('?')[0] !== PATH) return next()
  const host = req.headers.host ?? ''
  if (!/^(127\.0\.0\.1|localhost):(5173|4173)$/.test(host) || req.headers.origin && req.headers.origin !== `http://${host}`) return json(res, 403, { error: 'この空席照会はローカルのMileFinderから利用してください。' })
  if (req.method !== 'POST') return json(res, 405, { error: 'POSTのみ対応しています。' })
  if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: 'JSON形式の検索条件が必要です。' })
  if (busy) return json(res, 429, { error: '別の空席照会が進行中です。完了後に再度お試しください。' })
  let body = ''
  try {
    for await (const chunk of req) {
      body += chunk.toString()
      if (Buffer.byteLength(body) > 4096) return json(res, 413, { error: '検索条件が大きすぎます。' })
    }
    const query: unknown = JSON.parse(body)
    if (!validQuery(query)) return json(res, 400, { error: '対応する国際線の区間と、4日後〜355日後の最大7日間を指定してください。' })
    // 受信中に先行照会が開始された場合も、同時接続を増やさない。
    if (busy) return json(res, 429, { error: '別の空席照会が進行中です。' })
    busy = true
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 10 * 60 * 1000)
    res.on('close', () => abort.abort())
    try { json(res, 200, await searchAnaAvailability(query, abort.signal)) }
    catch (error) {
      // プロバイダー自身が定義する固定文だけを表示し、通信ライブラリのURLや認証値は返さない。
      const detail = error instanceof Error && /^(ANAチャット|指定した空港|指定期間|空席照会)/.test(error.message) ? error.message : 'ANAの空席回答を取得できませんでした。'
      json(res, 502, { error: `${detail} 空席なしを意味するものではありません。` })
    }
    finally { clearTimeout(timer); busy = false }
  } catch { json(res, 400, { error: '検索条件を読み取れませんでした。' }) }
}

export function anaAvailabilityPlugin(): Plugin {
  return { name: 'ana-availability', configureServer(server) { server.middlewares.use(createMemberWorkerConfig()); server.middlewares.use(middleware) }, configurePreviewServer(server) { server.middlewares.use(middleware) } }
}
