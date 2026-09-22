import { useEffect, useMemo, useRef, useState } from 'react'
import { Download, Link2, LoaderCircle, Square, Unplug } from 'lucide-react'
import type { SearchFilters } from './lib/search'
import type { MemberQuery } from './lib/anaMember'
import { buildMemberBookmarklet } from './lib/memberBridge'
import { memberHasSeats, memberQueries, memberRowKey, readMemberRows, validMemberQuery, type MemberRow } from './lib/memberResults'

const ANA_ORIGIN = 'https://aswbe-i.ana.co.jp'
const CHANNEL = 'milefinder-ana-member-v1'
const ERRORS: Record<string, string> = { captcha: 'ANAで画像認証が必要です。公式画面で認証し、接続をやり直してください。', login: 'ANAのログインまたは検索セッションが切れました。公式画面で再検索して接続してください。', unsupported: 'この会員検索の条件・画面にはまだ対応していません。', failed: 'ANAの回答を確認できませんでした。公式画面から接続し直してください。', busy: 'ANAで別の検索を処理しています。少し待ってください。' }
type Pending = { id: string; query: MemberQuery; resolve: (rows: MemberRow[]) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
type RemoteRequest = { controller: AbortController; id?: string; accessToken?: string; status?: string }
const REMOTE_ERRORS: Record<string, string> = {
  worker_offline: '現在、会員空席の照会に接続できません。時間をおいてもう一度お試しください。',
  expired: '照会の有効期限が切れました。空席なしとは判定していません。',
  rate_limited: '照会が混み合っています。少し時間をおいてお試しください。',
  queue_full: '照会が混み合っています。少し時間をおいてお試しください。',
  invalid_query: '日付・区間・人数の条件を確認してください。',
  route_unavailable: '現在接続している路線では、この条件を照会できません。',
  failed: '会員の空席回答を取得できませんでした。空席なしとは判定していません。',
  timeout: '会員の空席回答が時間切れになりました。空席なしとは判定していません。',
  cancelled: 'この照会は取り消されました。',
  captcha: '現在、会員空席の照会を利用できません。時間をおいてお試しください。',
  login: '現在、会員空席の照会を利用できません。時間をおいてお試しください。',
  unsupported: 'この条件の会員空席照会には対応していません。',
}

export default function MemberAvailabilityPanel({ filters, onConnected }: { filters: SearchFilters; onConnected: (query: MemberQuery) => void }) {
  const remote = !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
  const [connected, setConnected] = useState<MemberQuery | null>(null)
  const [rows, setRows] = useState<MemberRow[]>([])
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(0)
  const [planned, setPlanned] = useState(0)
  const [nextIndex, setNextIndex] = useState(0)
  const [notice, setNotice] = useState('')
  const [includeUnavailable, setIncludeUnavailable] = useState(false)
  const [open, setOpen] = useState(remote || new URLSearchParams(location.search).has('ana-member'))
  const [remoteStatus, setRemoteStatus] = useState<'loading' | 'online' | 'offline'>('loading')
  const peer = useRef<Window | null>(null)
  const connectionId = useRef(new URLSearchParams(location.search).get('ana-bridge'))
  const pending = useRef<Pending | null>(null)
  const remoteRequest = useRef<RemoteRequest | null>(null)
  const generation = useRef(0)
  const notified = useRef(false)
  const callback = useRef(onConnected); callback.current = onConnected
  const bookmark = useRef<HTMLAnchorElement>(null)
  const filterKey = JSON.stringify(filters)
  const queries = useMemo(() => memberQueries(filters, connected), [filters, connected])
  const budgetRows = rows.filter(r => r.totalMiles <= filters.budget)
  const shown = budgetRows.filter(r => includeUnavailable || memberHasSeats(r))

  function send(message: Record<string, unknown>) { peer.current?.postMessage({ channel: CHANNEL, connectionId: connectionId.current, ...message }, ANA_ORIGIN) }
  function discardRemote(request: RemoteRequest) {
    request.controller.abort()
    if (request.id && request.accessToken && request.status === 'queued') {
      void fetch(`/api/member/jobs/${encodeURIComponent(request.id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${request.accessToken}` }, signal: AbortSignal.timeout(10_000) }).catch(() => {})
    }
  }
  function cancel() {
    generation.current++
    const p = pending.current
    if (p) { clearTimeout(p.timer); pending.current = null; p.reject(new Error('照会を中止しました。取得済みの回答だけを表示します。')) }
    if (remoteRequest.current) { discardRemote(remoteRequest.current); remoteRequest.current = null }
    if (!remote) send({ type: 'cancel' })
    setRunning(false)
  }

  useEffect(() => {
    if (remote) {
      let disposed = false, busy = false
      const controller = new AbortController()
      const refresh = async () => {
        if (busy || disposed) return
        busy = true
        try {
          const response = await fetch('/api/member/status', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]), cache: 'no-store' })
          const data: unknown = await response.json()
          if (disposed) return
          const status = data as { connected?: unknown; query?: unknown }
          if (!response.ok || !status || status.connected !== true || !validMemberQuery(status.query)) {
            setConnected(null); setRemoteStatus('offline'); return
          }
          setConnected(status.query); setRemoteStatus('online')
          if (!notified.current) { notified.current = true; callback.current(status.query) }
        } catch { if (!disposed) { setConnected(null); setRemoteStatus('offline') } }
        finally { busy = false }
      }
      void refresh()
      const interval = setInterval(() => { void refresh() }, 5000)
      return () => { disposed = true; controller.abort(); clearInterval(interval); generation.current++; if (remoteRequest.current) { discardRemote(remoteRequest.current); remoteRequest.current = null } }
    }
    const opener: Window | null = window.opener
    const session = connectionId.current
    if (!opener || !new URLSearchParams(location.search).has('ana-member') || !session || !/^[0-9a-f-]{36}$/i.test(session)) return
    peer.current = opener
    const ready = () => opener.postMessage({ channel: CHANNEL, connectionId: session, type: 'ready' }, ANA_ORIGIN)
    const receive = (event: MessageEvent) => {
      if (event.origin !== ANA_ORIGIN || event.source !== opener || !event.data || event.data.channel !== CHANNEL || event.data.connectionId !== session) return
      const data = event.data
      if (data.type === 'connected' && validMemberQuery(data.query)) {
        setConnected({ origin: data.query.origin, destination: data.query.destination, departureDate: data.query.departureDate, returnDate: data.query.returnDate, cabin: data.query.cabin, passengers: data.query.passengers }); setOpen(true)
        if (!notified.current) { notified.current = true; callback.current(data.query) }
        clearInterval(handshake); return
      }
      const p = pending.current
      if (!p || data.id !== p.id || !['result', 'error'].includes(data.type)) return
      clearTimeout(p.timer); pending.current = null
      if (data.type === 'error') { p.reject(new Error(ERRORS[data.code] || ERRORS.failed)); if (['captcha', 'login', 'failed'].includes(data.code)) setConnected(null); return }
      try { p.resolve(readMemberRows(data, p.query)) } catch (error) { p.reject(error instanceof Error ? error : new Error(ERRORS.failed)) }
    }
    window.addEventListener('message', receive)
    const handshake = setInterval(ready, 2000); ready()
    const expiry = setTimeout(() => clearInterval(handshake), 60_000)
    const leave = () => opener.postMessage({ channel: CHANNEL, connectionId: session, type: 'disconnect' }, ANA_ORIGIN)
    window.addEventListener('beforeunload', leave)
    return () => { clearInterval(handshake); clearTimeout(expiry); window.removeEventListener('message', receive); window.removeEventListener('beforeunload', leave); generation.current++; const p = pending.current; if (p) { clearTimeout(p.timer); p.reject(new Error('接続を終了しました。')); pending.current = null; opener.postMessage({ channel: CHANNEL, connectionId: session, type: 'cancel' }, ANA_ORIGIN) }; peer.current = null }
  }, [])

  useEffect(() => { cancel(); setRows([]); setProgress(0); setPlanned(0); setNextIndex(0); setNotice('') }, [filterKey])
  useEffect(() => { if (!remote && bookmark.current) bookmark.current.href = buildMemberBookmarklet(location.origin) }, [open, connected, remote])

  async function requestRemote(query: MemberQuery, run: number): Promise<MemberRow[]> {
    const active: RemoteRequest = { controller: new AbortController() }
    remoteRequest.current = active
    const failure = (code: unknown) => new Error(REMOTE_ERRORS[String(code)] || REMOTE_ERRORS.failed)
    try {
      // 作成要求は中止後も応答を受け取り、発行済みの待機ジョブを取り消す。
      const created = await fetch('/api/member/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(20_000) })
      const job = await created.json() as { id?: string; accessToken?: string; status?: string; error?: string }
      if (!created.ok) throw failure(job.error)
      if (typeof job.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(job.id) || typeof job.accessToken !== 'string' || !/^[A-Za-z0-9._~-]{16,512}$/.test(job.accessToken) || !['queued', 'running', 'succeeded'].includes(job.status || '')) throw failure('failed')
      active.id = job.id; active.accessToken = job.accessToken; active.status = job.status
      if (run !== generation.current || active.controller.signal.aborted) { discardRemote(active); throw failure('cancelled') }
      const deadline = Date.now() + 180_000
      while (Date.now() < deadline) {
        const response = await fetch(`/api/member/jobs/${encodeURIComponent(job.id)}`, { headers: { Authorization: `Bearer ${job.accessToken}` }, signal: AbortSignal.any([active.controller.signal, AbortSignal.timeout(15_000)]), cache: 'no-store' })
        const answer = await response.json() as { id?: string; status?: string; result?: unknown; error?: string }
        if (!response.ok) throw failure(answer.error)
        if (answer.id !== job.id || !['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(answer.status || '')) throw failure('failed')
        active.status = answer.status
        if (answer.status === 'succeeded') return readMemberRows(answer.result, query)
        if (answer.status === 'failed' || answer.status === 'cancelled') throw failure(answer.error || answer.status)
        await new Promise<void>((resolve, reject) => {
          const signal = active.controller.signal
          const stop = () => { clearTimeout(timer); reject(failure('cancelled')) }
          const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve() }, 1000)
          if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true })
        })
      }
      discardRemote(active); throw failure('timeout')
    } catch (error) {
      if (error instanceof Error && (Object.values(REMOTE_ERRORS).includes(error.message) || error.message.startsWith('会員検索'))) throw error
      throw failure(error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'failed')
    } finally { if (remoteRequest.current === active) remoteRequest.current = null }
  }

  async function start() {
    if (!connected || running) return
    const batch = queries.slice(nextIndex, nextIndex + 7)
    const run = ++generation.current
    setRunning(true); setPlanned(queries.length); setNotice('')
    try {
      for (const [i, query] of batch.entries()) {
        if (run !== generation.current) return
        if (!remote && peer.current?.closed) throw new Error('ANAのタブが閉じられました。再接続してください。')
        const received = remote ? await requestRemote(query, run) : await new Promise<MemberRow[]>((resolve, reject) => {
          const id = crypto.randomUUID()
          const timer = setTimeout(() => { pending.current = null; reject(new Error('会員検索の回答が時間切れになりました。空席なしを意味しません。')); send({ type: 'cancel' }) }, 70_000)
          pending.current = { id, query, resolve, reject, timer }; send({ type: 'search', id, query })
        })
        if (run !== generation.current) return
        setRows(old => [...new Map([...old, ...received].map(r => [memberRowKey(r), r])).values()]); setProgress(nextIndex + i + 1); setNextIndex(nextIndex + i + 1)
        if (i < batch.length - 1) await new Promise(resolve => setTimeout(resolve, 1000))
      }
    } catch (error) { if (run === generation.current) setNotice(error instanceof Error ? error.message : ERRORS.failed) }
    finally { if (run === generation.current) setRunning(false) }
  }

  function download() {
    const cell = (value: unknown) => `"${String(value).replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""')}"`
    const data = [['往路出発日（現地）', '往路便', '往路出発地', '往路到着地', '復路出発日（現地）', '復路便', '復路出発地', '復路到着地', '往路席数', '復路席数', '往路空席待ち', '復路空席待ち', '成人', '人数を満たす', '必要マイル合計', '税金等合計（円）', '確認日時', '取得元', '取得範囲'], ...shown.map(r => [r.outbound[0].date, r.outbound[0].flightNumber, r.outbound[0].origin, r.outbound[0].destination, r.inbound[0].date, r.inbound[0].flightNumber, r.inbound[0].origin, r.inbound[0].destination, r.outboundSeats, r.inboundSeats, r.outboundWaitlist === undefined ? '未確認' : r.outboundWaitlist ? 'はい' : 'いいえ', r.inboundWaitlist === undefined ? '未確認' : r.inboundWaitlist ? 'はい' : 'いいえ', r.passengers, memberHasSeats(r) ? 'はい' : 'いいえ', r.totalMiles, r.totalCashJpy, r.checkedAt, 'ANA会員検索', '部分取得・発券未確認'])]
    const url = URL.createObjectURL(new Blob(['\uFEFF' + data.map(row => row.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a'); a.href = url; a.download = 'milefinder-member-availability.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return <section className="member-panel" aria-label="ANA会員の空席照会">
    <button className="member-toggle" aria-expanded={open} onClick={() => setOpen(!open)}><Link2 size={18} /><span>ANA会員の空席照会<small>{connected ? `${connected.origin} → ${connected.destination} に接続中` : remote ? remoteStatus === 'loading' ? '接続状態を確認中' : '現在接続できません' : '公式予約画面のログイン状態で検索'}</small></span><span>{open ? '閉じる' : remote ? '照会を見る' : '接続方法を見る'}</span></button>
    {open && <div className="member-content">
      {!connected ? remote ? <p className="live-notice">{remoteStatus === 'loading' ? '会員空席の接続状態を確認しています。' : '現在、会員空席の照会に接続できません。空席なしとは判定していません。時間をおいてもう一度お試しください。'}</p> : <><p>ANAで国際線・往復・エコノミーを一度検索し、フライト一覧を表示してください。</p><ol><li>下の「ANA会員検索を接続」をブラウザーのブックマークバーへドラッグします。</li><li>ANAのフライト一覧で、そのブックマークを実行します。</li><li>新しく開くMileFinderで日付・人数・マイル条件を指定します。</li></ol><a ref={bookmark} className="member-bookmark" onClick={e => { e.preventDefault(); setNotice('このボタンをブックマークバーへドラッグし、ANAのフライト一覧で実行してください。') }}>ANA会員検索を接続</a><p className="live-scope">パスワードやログイン情報はANAのタブに保持し、空席・料金の回答だけをこの画面へ渡します。接続後はANAのタブを開いたままにしてください。</p></> : <>
        <div className="member-connected"><span><Link2 size={15} />{connected.origin} → {connected.destination} · 会員の検索結果に接続中</span>{!remote && <button onClick={() => { cancel(); send({ type: 'disconnect' }); setConnected(null); setNotice('接続を終了しました。') }}><Unplug size={14} />接続解除</button>}</div>
        <p>上の検索条件で、接続した路線を照会します。国際線の往復・エコノミー・成人に対応しています。</p>
        <p className="live-scope">{remote ? 'ログインの入力は不要です。接続中の会員検索から回答を取得します。表示されない便・日付は未確認です。' : '公式画面に表示中の条件は、その結果を取り込みます。別の日付・人数は会員検索へ照会します。会員の連続照会は検証中で、ANAの応答が途切れる場合があります。複数日は上の未ログイン空席照会も利用できます。'}</p>
        {!queries.length && <p className="live-notice">接続した路線に合う出発地・行き先を選び、往復・エコノミーで「この条件で探す」を押してください。</p>}
        <div className="member-actions"><span>{queries.length}日分の条件 · 1回に最大7日を順番に照会</span>{running ? <button className="secondary-button" onClick={() => { cancel(); setNotice(remote ? '結果の取得を停止しました。待機中の照会を取り消し、処理中の照会は完了まで継続します。' : '照会を中止しました。取得済みの回答だけを表示します。') }}><Square size={15} />会員照会を中止</button> : <button className="primary-button" onClick={start} disabled={!queries.length || nextIndex >= queries.length}>{nextIndex && nextIndex < queries.length ? '次の7日を照会' : '会員の空席を一括照会'}</button>}</div>
      </>}
      {remote && running && !connected && <button className="secondary-button" onClick={() => { cancel(); setNotice('結果の取得を停止しました。処理中の照会は完了まで継続します。') }}>会員照会を中止</button>}
      {(running || progress > 0) && <div role="status" className="live-progress">{running && <LoaderCircle size={16} className="spinning" />}会員検索 {progress} / {planned}日{!running && connected && nextIndex < queries.length && ' · 続きの照会が可能です'}</div>}
      {notice && <p role="alert" className="live-notice">{notice}</p>}
      {rows.length > 0 && <><div className="live-results-top"><strong>予算内で人数を満たす会員候補 {budgetRows.filter(memberHasSeats).length}組</strong><label><input type="checkbox" checked={includeUnavailable} onChange={e => setIncludeUnavailable(e.target.checked)} />空席なし・空席待ちも表示</label><button className="export-button" disabled={!shown.length} onClick={download}><Download size={15} />会員空席CSV</button></div><div className="table-scroll"><table className="live-table"><thead><tr><th>往路・現地出発日</th><th>復路・現地出発日</th><th>回答席数</th><th>{filters.passengers}名の合計</th><th>確認時刻</th></tr></thead><tbody>{shown.map(r => <tr key={memberRowKey(r)}><td>{r.outbound[0].date}<small>{r.outbound[0].flightNumber} · {r.outbound[0].origin} → {r.outbound[0].destination}</small></td><td>{r.inbound[0].date}<small>{r.inbound[0].flightNumber} · {r.inbound[0].origin} → {r.inbound[0].destination}</small></td><td><span className={memberHasSeats(r) ? 'seats-available' : 'seats-empty'}>往路 {r.outboundSeats}席 / 復路 {r.inboundSeats}席</span>{(r.outboundWaitlist || r.inboundWaitlist) && <small>空席待ちを含む</small>}</td><td>{r.totalMiles.toLocaleString('ja-JP')} マイル<small>税金等 {r.totalCashJpy.toLocaleString('ja-JP')} 円</small></td><td>{new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' }).format(new Date(r.checkedAt))}<small>日本時間</small></td></tr>)}</tbody></table></div>{!shown.length && <p className="live-empty">取得できた回答に、予算と人数を満たす候補はありません。空席なし・空席待ちも表示すると回答を確認できます。</p>}<p className="live-scope">会員検索が返した便の組み合わせ・人数分の料金です。空席待ちは空席ありに含めません。未対応の便・乗継は部分取得となり、発券できるかはANA公式での確認が必要です。</p></>}
    </div>}
  </section>
}
