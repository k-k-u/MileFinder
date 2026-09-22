import { useEffect, useRef, useState } from 'react'
import { Link2, LoaderCircle, ShieldCheck, Square } from 'lucide-react'
import type { MemberQuery } from './lib/anaMember'
import { buildMemberBookmarklet } from './lib/memberBridge'
import { readMemberRows, validMemberQuery, type MemberRow } from './lib/memberResults'

const PUBLIC_ORIGIN = 'https://milefinder-ana-awards.raisin7524.chatgpt.site'
const ANA_ORIGIN = 'https://aswbe-i.ana.co.jp'
const CHANNEL = 'milefinder-ana-member-v1'
const localHost = (hostname: string) => ['localhost', '127.0.0.1', '[::1]'].includes(hostname)
const validToken = (value: string) => /^[A-Za-z0-9._~-]{24,512}$/.test(value)
type Configuration = { apiOrigin: string; token: string; valid: boolean }
type Pending = { id: string; query: MemberQuery; resolve: (rows: MemberRow[]) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
type Lease = { id: string; leaseId: string; query: MemberQuery; expiresAt: string }

function configuration(): Configuration {
  if (!localHost(location.hostname)) return { apiOrigin: '', token: '', valid: false }
  const parameters = new URLSearchParams(location.search)
  const fragment = new URLSearchParams(location.hash.slice(1))
  const fragmentToken = fragment.get('worker-token')
  if (fragmentToken !== null) history.replaceState(history.state, '', location.pathname + location.search)
  const rawOrigin = parameters.get('api-origin') || PUBLIC_ORIGIN
  let valid = false
  try {
    const url = new URL(rawOrigin)
    valid = rawOrigin === url.origin && (rawOrigin === PUBLIC_ORIGIN || url.protocol === 'http:' && localHost(url.hostname))
  } catch { /* 許可したorigin以外にトークンを送らない。 */ }
  if (!valid) return { apiOrigin: '', token: '', valid: false }
  let token = ''
  try {
    const key = `milefinder:member-worker:${rawOrigin}`
    if (fragmentToken && validToken(fragmentToken)) sessionStorage.setItem(key, fragmentToken)
    token = sessionStorage.getItem(key) || ''
  } catch { if (fragmentToken && validToken(fragmentToken)) token = fragmentToken }
  return { apiOrigin: rawOrigin, token: validToken(token) ? token : '', valid: true }
}

export default function MemberWorkerPanel() {
  const [config] = useState(configuration)
  const [input, setInput] = useState('')
  const token = useRef(config.token)
  const [enabled, setEnabled] = useState(Boolean(config.token))
  const [bridge, setBridge] = useState<MemberQuery | null>(null)
  const [phase, setPhase] = useState<'waiting' | 'connecting' | 'online' | 'working' | 'offline' | 'stopped'>('waiting')
  const [notice, setNotice] = useState(config.valid ? '' : '接続先の設定を確認してください。許可されていない接続先には送信しません。')
  const [completed, setCompleted] = useState(0)
  const peer = useRef<Window | null>(null)
  const session = useRef(new URLSearchParams(location.search).get('ana-bridge'))
  const pending = useRef<Pending | null>(null)
  const bridgeValue = useRef<MemberQuery | null>(null)
  const bridgeDeadline = useRef(0)
  const localSettings = useRef<Promise<unknown> | null>(null)
  const bookmark = useRef<HTMLAnchorElement>(null)

  useEffect(() => {
    if (config.valid && bookmark.current) bookmark.current.href = buildMemberBookmarklet(location.origin, true)
  }, [config])

  function send(message: Record<string, unknown>) {
    peer.current?.postMessage({ channel: CHANNEL, connectionId: session.current, ...message }, ANA_ORIGIN)
  }
  async function api(path: string, body: unknown, signal?: AbortSignal) {
    if (!config.valid || !validToken(token.current)) throw new Error('failed')
    const response = await fetch(`${config.apiOrigin}${path}`, {
      method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token.current}` },
      body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error('failed')
    return response.json() as Promise<Record<string, unknown>>
  }

  useEffect(() => {
    if (!config.valid || config.apiOrigin !== PUBLIC_ORIGIN || token.current) return
    let disposed = false
    // StrictModeでも一度だけ読み取り、返却値はローカル管理画面だけで保持する。
    localSettings.current ??= fetch('/api/member-worker/local-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(8000) }).then(response => response.ok ? response.json() : null).catch(() => null)
    void localSettings.current.then(value => {
      if (disposed || token.current || !value || typeof value !== 'object') return
      const saved = value as { apiOrigin?: unknown; token?: unknown }
      if (saved.apiOrigin !== config.apiOrigin || typeof saved.token !== 'string' || !validToken(saved.token)) return
      token.current = saved.token
      try { sessionStorage.setItem(`milefinder:member-worker:${config.apiOrigin}`, saved.token) } catch { /* 現在の画面だけで保持する。 */ }
      setInput(''); setEnabled(true)
    })
    return () => { disposed = true }
  }, [config])

  useEffect(() => {
    const opener: Window | null = window.opener
    const connectionId = session.current
    if (!config.valid || !opener || !new URLSearchParams(location.search).has('ana-member') || !connectionId || !/^[0-9a-f-]{36}$/i.test(connectionId)) {
      setNotice('ANAのフライト一覧から、管理用の接続を開いてください。'); return
    }
    peer.current = opener
    const receive = (event: MessageEvent) => {
      if (event.origin !== ANA_ORIGIN || event.source !== opener || !event.data || event.data.channel !== CHANNEL || event.data.connectionId !== connectionId) return
      const data = event.data
      if (data.type === 'connected' && validMemberQuery(data.query)) {
        if (!bridgeValue.current) { bridgeValue.current = data.query; bridgeDeadline.current = Date.now() + 29 * 60_000; setBridge(data.query); setNotice('') }
        clearInterval(handshake); return
      }
      const current = pending.current
      if (!current || data.id !== current.id || !['result', 'error'].includes(data.type)) return
      clearTimeout(current.timer); pending.current = null
      if (data.type === 'error') { current.reject(new Error(['captcha', 'login', 'unsupported', 'failed', 'busy'].includes(data.code) ? data.code : 'failed')); return }
      try { current.resolve(readMemberRows(data, current.query)) } catch { current.reject(new Error('failed')) }
    }
    const ready = () => opener.postMessage({ channel: CHANNEL, connectionId, type: 'ready' }, ANA_ORIGIN)
    window.addEventListener('message', receive)
    const handshake = setInterval(ready, 2000); ready()
    const expiry = setTimeout(() => clearInterval(handshake), 60_000)
    const leave = () => {
      opener.postMessage({ channel: CHANNEL, connectionId, type: 'disconnect' }, ANA_ORIGIN)
      if (validToken(token.current)) void fetch(`${config.apiOrigin}/api/worker/heartbeat`, { method: 'POST', credentials: 'omit', keepalive: true, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token.current}` }, body: JSON.stringify({ query: null }) }).catch(() => {})
    }
    window.addEventListener('beforeunload', leave)
    return () => {
      clearInterval(handshake); clearTimeout(expiry); window.removeEventListener('message', receive); window.removeEventListener('beforeunload', leave)
      const current = pending.current
      if (current) { clearTimeout(current.timer); pending.current = null; current.reject(new Error('cancelled')); opener.postMessage({ channel: CHANNEL, connectionId, type: 'cancel' }, ANA_ORIGIN) }
      peer.current = null
    }
  }, [config])

  useEffect(() => {
    if (!enabled || !bridge || !config.valid || !token.current) return
    let alive = true, claiming = false, heartbeating = false, registered = false
    const controller = new AbortController()
    let currentLease: Lease | null = null
    setPhase('connecting'); setNotice('')
    function offline() {
      if (!alive) return
      alive = false
      setPhase('offline'); setEnabled(false); setBridge(null); bridgeValue.current = null
      setNotice('接続を停止しました。ANAのフライト一覧から接続をやり直してください。取得失敗を空席なしとして送信していません。')
      send({ type: 'cancel' }); controller.abort()
      void api('/api/worker/heartbeat', { query: null }).catch(() => {})
    }
    const heartbeat = async () => {
      if (!alive || heartbeating) return false
      heartbeating = true
      try { const data = await api('/api/worker/heartbeat', { query: bridge }, controller.signal); if (data.ok !== true) throw new Error('failed'); registered = true; return true }
      catch { offline(); return false }
      finally { heartbeating = false }
    }
    const claim = async () => {
      if (!alive || !registered || claiming) return
      claiming = true
      try {
        if (peer.current?.closed) throw new Error('login')
        const response = await api('/api/worker/claim', {}, controller.signal)
        if (!alive) return
        if (response.job === null) { setPhase('online'); return }
        const lease = response.job as Lease | undefined
        if (!lease || typeof lease.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(lease.id) || typeof lease.leaseId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(lease.leaseId) || !validMemberQuery(lease.query) || lease.query.origin !== bridge.origin || lease.query.destination !== bridge.destination || !Number.isFinite(Date.parse(lease.expiresAt)) || Date.parse(lease.expiresAt) <= Date.now()) throw new Error('unsupported')
        currentLease = lease; setPhase('working')
        const rows = await new Promise<MemberRow[]>((resolve, reject) => {
          const id = crypto.randomUUID()
          const timer = setTimeout(() => { pending.current = null; send({ type: 'cancel' }); reject(new Error('timeout')) }, 70_000)
          pending.current = { id, query: lease.query, resolve, reject, timer }
          send({ type: 'search', id, query: lease.query })
        })
        if (!alive) return
        const itineraries = rows.map(r => ({ outbound: r.outbound, inbound: r.inbound, outboundSeats: r.outboundSeats, inboundSeats: r.inboundSeats, totalMiles: r.totalMiles, totalCashJpy: r.totalCashJpy, ...(r.outboundWaitlist === undefined ? {} : { outboundWaitlist: r.outboundWaitlist }), ...(r.inboundWaitlist === undefined ? {} : { inboundWaitlist: r.inboundWaitlist }) }))
        const posted = await api(`/api/worker/jobs/${encodeURIComponent(lease.id)}/result`, { leaseId: lease.leaseId, result: { query: lease.query, itineraries, checkedAt: rows[0].checkedAt, source: 'ana-member', partial: true } }, controller.signal)
        if (posted.ok !== true) throw new Error('failed')
        currentLease = null
        if (alive) { setCompleted(count => count + 1); setPhase('online') }
      } catch (error) {
        if (!alive) return
        if (currentLease) {
          const code = error instanceof Error && ['captcha', 'login', 'unsupported', 'timeout', 'cancelled'].includes(error.message) ? error.message : 'failed'
          await api(`/api/worker/jobs/${encodeURIComponent(currentLease.id)}/result`, { leaseId: currentLease.leaseId, error: code }, controller.signal).catch(() => {})
          currentLease = null
        }
        offline()
      } finally { claiming = false }
    }
    const heartbeatTimer = setInterval(() => { void heartbeat() }, 5000)
    const claimTimer = setInterval(() => { void claim() }, 2000)
    // ANA側の30分期限より前に公開接続を停止する。
    const lifetime = setTimeout(offline, Math.max(0, bridgeDeadline.current - Date.now()))
    void heartbeat().then(ok => { if (ok && alive) void claim() })
    return () => {
      alive = false; controller.abort(); clearInterval(heartbeatTimer); clearInterval(claimTimer); clearTimeout(lifetime)
      const current = pending.current
      if (current) { clearTimeout(current.timer); pending.current = null; current.reject(new Error('cancelled')); send({ type: 'cancel' }) }
    }
  }, [enabled, bridge, config])

  function start() {
    if (!config.valid || !validToken(input)) { setNotice('ワーカートークンを確認してください。'); return }
    token.current = input
    try { sessionStorage.setItem(`milefinder:member-worker:${config.apiOrigin}`, input) } catch { /* 現在の画面だけで保持する。 */ }
    setInput(''); setEnabled(true); setNotice('')
  }
  function stop() {
    void api('/api/worker/heartbeat', { query: null }).catch(() => {})
    setEnabled(false); setPhase('stopped'); send({ type: 'cancel' }); send({ type: 'disconnect' })
    setBridge(null); bridgeValue.current = null
    try { sessionStorage.removeItem(`milefinder:member-worker:${config.apiOrigin}`) } catch { /* 保存できない環境ではメモリーだけを消す。 */ }
    token.current = ''; setNotice('接続を停止しました。再開する場合はANAのフライト一覧から接続してください。')
  }
  const labels = { waiting: 'ANAへの接続待ち', connecting: '公開サイトへ接続中', online: '照会を待機中', working: 'ANAへ1件照会中', offline: '接続停止・再接続が必要', stopped: '停止しました' }
  return <main className="worker-page"><section className="member-panel" aria-label="会員検索ワーカー">
    <div className="worker-heading"><ShieldCheck size={28} /><div><h1>会員検索の接続</h1><p>この管理画面とANAのタブを開いたままにしてください。</p></div></div>
    <div className="member-content">{config.valid && <div className="worker-setup"><p>下のリンクをブックマークバーへ保存し、ANAの国際線・往復・エコノミーのフライト一覧で実行してください。</p><a ref={bookmark} className="member-bookmark" onClick={event => { event.preventDefault(); setNotice('リンクをブックマークバーへドラッグして保存し、ANAのフライト一覧で実行してください。') }}>公開サイトの会員検索を接続</a><p className="live-scope">この管理用ブックマークにはログイン情報やワーカートークンを含めません。</p></div>}<p className="worker-state" role="status">{['connecting', 'working'].includes(phase) ? <LoaderCircle className="spinning" size={18} /> : <Link2 size={18} />}{labels[phase]}</p>
      {bridge && <p>{bridge.origin} → {bridge.destination} · 国際線往復・エコノミー</p>}
      {!enabled && config.valid && <form className="worker-token-form" onSubmit={event => { event.preventDefault(); start() }}><label>ワーカートークン<input aria-label="ワーカートークン" type="password" autoComplete="off" value={input} onChange={event => setInput(event.target.value)} /></label><button className="primary-button" type="submit">接続を開始</button></form>}
      {enabled && <button className="secondary-button" onClick={stop}><Square size={16} />接続を停止</button>}
      {notice && <p className="live-notice" role="alert">{notice}</p>}
      <p className="live-scope">この画面からの完了送信 {completed}件。トークンはこのローカル画面だけで保持し、ANAには送信しません。接続から29分、またはログインや画像認証が必要になった場合は自動照会を停止します。</p>
    </div>
  </section></main>
}
