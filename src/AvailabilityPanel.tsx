import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Download, LoaderCircle, Radio, Square } from 'lucide-react'
import type { AnaChatOffer } from './lib/anaChat'
import { buildAvailabilityQueries, filterLiveOffers, filterOffersForQuery, pairRoundtripOffers } from './lib/liveSearch'
import type { SearchFilters, SearchResult } from './lib/search'

type Snapshot = { offer: AnaChatOffer; checkedAt: string }
type Reply = { offers: AnaChatOffer[]; checkedAt: string; partial: boolean; notes: string[]; error?: string }
const key = (o: AnaChatOffer) => [o.flightNumber, o.originLabel, o.destinationLabel, o.date, o.time, o.cabin].join('|')
const clock = (date: string) => new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' }).format(new Date(date))

export default function AvailabilityPanel({ results, filters }: { results: SearchResult[]; filters: SearchFilters }) {
  const [destination, setDestination] = useState('all')
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'stopped' | 'error'>('idle')
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [progress, setProgress] = useState(0)
  const [active, setActive] = useState('')
  const [notices, setNotices] = useState<string[]>([])
  const [showInsufficient, setShowInsufficient] = useState(false)
  const abort = useRef<AbortController | null>(null)
  const destinations = [...new Map(results.filter(r => r.route.kind === 'international').map(r => [r.destination.code, r.destination])).values()]
  const queries = useMemo(() => buildAvailabilityQueries(results, filters, destination), [results, filters, destination])
  const rows = useMemo(() => filterLiveOffers(snapshots.map(s => s.offer), results, filters), [snapshots, results, filters])
  const pairs = useMemo(() => pairRoundtripOffers(snapshots.map(s => s.offer), results, filters), [snapshots, results, filters])
  const roundtrip = filters.tripType === 'roundtrip'
  const enough = (pair: (typeof pairs)[number]) => pair.outbound.seats >= filters.passengers && pair.inbound.seats >= filters.passengers
  const shown = rows.filter(r => showInsufficient || r.offer.seats >= filters.passengers)
  const shownPairs = pairs.filter(p => showInsufficient || enough(p))
  const availableCount = roundtrip ? pairs.filter(enough).length : rows.filter(r => r.offer.seats >= filters.passengers).length
  const shownCount = roundtrip ? shownPairs.length : shown.length
  const times = new Map(snapshots.map(s => [key(s.offer), s.checkedAt]))
  const unsupported = destinations.length === 0
  useEffect(() => () => abort.current?.abort(), [])

  async function start() {
    const controller = new AbortController()
    abort.current = controller
    setState('running'); setProgress(0); setSnapshots([]); setNotices([])
    try {
      for (const [index, query] of queries.entries()) {
        setActive(`${query.origin} → ${query.destination} / ${query.dateFrom}〜${query.dateTo}`)
        const response = await fetch('/api/ana/availability', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query), signal: controller.signal })
        if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('空席照会サーバーに接続できません。npm run dev または npm run preview で起動してください。')
        const data = await response.json() as Reply
        if (!response.ok) throw new Error(data.error || '空席回答を取得できませんでした。')
        if (!Array.isArray(data.offers) || !Number.isFinite(Date.parse(data.checkedAt))) throw new Error('空席回答の形式を確認できませんでした。')
        if (controller.signal.aborted) return
        const matched = filterOffersForQuery(data.offers, query, filters.cabin)
        setSnapshots(old => [...new Map([...old, ...matched.map(offer => ({ offer, checkedAt: data.checkedAt }))].map(s => [key(s.offer), s])).values()])
        if (data.partial) setNotices(n => [...new Set([...n, '一部の回答のみ取得できました。表示されない便・日付の空席は未確認です。'])])
        setProgress(index + 1)
      }
      setState('done')
    } catch (error) {
      if (controller.signal.aborted) { setState('stopped'); return }
      setState('error'); setNotices(n => [...n, error instanceof Error ? error.message : '空席回答を取得できませんでした。'])
    } finally { setActive('') }
  }

  function csv() {
    const cell = (v: string | number) => `"${String(v).replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""')}"`
    const legCells = (o: AnaChatOffer) => [o.date, o.flightNumber, o.originLabel, o.destinationLabel, o.time, o.seats, times.get(key(o)) ?? '']
    const values = roundtrip
      ? [['往路出発日（現地）', '往路便名', '往路出発地', '往路到着地', '往路出発時刻', '往路回答席数', '往路確認日時', '復路出発日（現地）', '復路便名', '復路出発地', '復路到着地', '復路出発時刻', '復路回答席数', '復路確認日時', 'クラス', '希望人数', '両便で人数を満たす', '合計必要マイル', 'データ提供', '会員区分', '取得範囲'], ...shownPairs.map(p => [...legCells(p.outbound), ...legCells(p.inbound), filters.cabin, filters.passengers, enough(p) ? 'はい' : 'いいえ', p.totalMiles, 'ANA公式チャット', '未ログイン', '部分取得・旅程全体の予約可否は未確認'])]
      : [['出発日', '便名', '出発地', '到着地', '出発時刻', 'クラス', '回答席数', '希望人数', '人数を満たす', '合計必要マイル', '確認日時', 'データ提供', '会員区分'], ...shown.map(({ offer: o, totalMiles }) => [o.date, o.flightNumber, o.originLabel, o.destinationLabel, o.time, filters.cabin, o.seats, filters.passengers, o.seats >= filters.passengers ? 'はい' : 'いいえ', totalMiles, times.get(key(o)) ?? '', 'ANA公式チャット', '未ログイン'])]
    const url = URL.createObjectURL(new Blob(['\uFEFF' + values.map(r => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a'); a.href = url; a.download = roundtrip ? 'milefinder-roundtrip-availability.csv' : 'milefinder-availability.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return <section className="live-panel" aria-label="実際の空席を一括照会">
    <div className="live-heading"><div><span className="live-eyebrow"><Radio size={14} />ANA公式の空席回答</span><h2>実際の空席を、一度に。</h2><p>{roundtrip ? '国際線の往路・復路を照会し、両便の空席を満たす組み合わせを探します。' : '国際線の片道・直行便を順番に照会。回答の席数を人数・クラス・マイル条件で絞り込みます。'}</p></div><span className="live-badge">未ログインの空席</span></div>
    <div className="live-controls"><label>照会する行き先<select aria-label="空席照会の行き先" value={destination} disabled={state === 'running'} onChange={e => { setDestination(e.target.value); setSnapshots([]); setProgress(0); setNotices([]); setState('idle') }}><option value="all">候補の国際線すべて</option>{destinations.map(d => <option key={d.code} value={d.code}>{d.city}（{d.code}）</option>)}</select></label><div className="live-query-count"><strong>{queries.length}</strong>回の照会<small>1回あたり最大7日・数分程度</small></div>{state === 'running' ? <button className="secondary-button" onClick={() => abort.current?.abort()}><Square size={15} />照会を中止</button> : <button className="primary-button" disabled={unsupported || !queries.length} onClick={start}><Radio size={17} />空席をまとめて照会</button>}</div>
    <p className="live-scope">{unsupported ? '空席照会は国際線の候補で利用できます。国内線の空席はANA予約画面で確認してください。' : '照会対象は4日後〜355日後。会員ステイタスによる優先枠は含みません。予約時にはANA公式で再確認してください。'}</p>
    {roundtrip && !unsupported && <p className="live-scope">復路の日付は現地の出発日です。同じ空港に戻る直行便を組み合わせます。必要マイルは公開表の計算値で、旅程全体の予約可否はANA公式で確認してください。</p>}
    {state !== 'idle' && <>
      <div className="live-progress" role="status">{state === 'running' ? <LoaderCircle className="spinning" size={16} /> : <Check size={16} />}<span>{state === 'running' ? 'ANAの回答を取得しています' : state === 'done' ? '照会が終了しました' : state === 'stopped' ? '照会を中止しました' : '照会を停止しました'} · {progress} / {queries.length}<small>{active || '結果は取得時点の回答です。表示されない便・クラスの空席は未確認です。'}</small></span></div>
      {notices.map(n => <p className="live-notice" key={n}>{n}</p>)}
      <div className="live-results-top"><strong>{roundtrip ? `人数を満たす往復候補 ${availableCount}組` : `人数を満たす空席 ${availableCount}件`}</strong><label><input type="checkbox" checked={showInsufficient} onChange={e => setShowInsufficient(e.target.checked)} />残席不足・0席も表示</label><button className="export-button" onClick={csv} disabled={!shownCount}><Download size={15} />空席CSV</button></div>
      {roundtrip ? shownPairs.length ? <div className="table-scroll"><table className="live-table"><thead><tr><th>往路・現地出発日時</th><th>復路・現地出発日時</th><th>回答席数</th><th>{filters.passengers}名の往復必要マイル</th><th>確認時刻</th></tr></thead><tbody>{shownPairs.map(p => <tr key={`${key(p.outbound)}|${key(p.inbound)}`}><td><strong>{p.outbound.date} {p.outbound.time}</strong><small>{p.outbound.flightNumber} · {p.outbound.originLabel}</small><small>→ {p.outbound.destinationLabel}</small></td><td><strong>{p.inbound.date} {p.inbound.time}</strong><small>{p.inbound.flightNumber} · {p.inbound.originLabel}</small><small>→ {p.inbound.destinationLabel}</small></td><td><span className={p.outbound.seats >= filters.passengers ? 'seats-available' : 'seats-empty'}>往路 {p.outbound.seats}席</span><small><span className={p.inbound.seats >= filters.passengers ? 'seats-available' : 'seats-empty'}>復路 {p.inbound.seats}席</span></small></td><td>{p.totalMiles.toLocaleString('ja-JP')}</td><td><small>往路 {clock(times.get(key(p.outbound))!)}</small><small>復路 {clock(times.get(key(p.inbound))!)}</small><small>日本時間</small></td></tr>)}</tbody></table></div> : <p className="live-empty">{pairs.length ? '取得した往復の回答では、両便で希望人数を満たす組み合わせがありません。「残席不足・0席も表示」で回答を確認できます。' : `往路・復路の回答がそろった組み合わせはまだありません。取得済み ${snapshots.length}件の便別回答。未取得の便・日付は未確認です。`}</p> : shown.length ? <div className="table-scroll"><table className="live-table"><thead><tr><th>出発日・便名</th><th>区間</th><th>回答席数</th><th>{filters.passengers}名の必要マイル</th><th>確認時刻</th></tr></thead><tbody>{shown.map(({ offer: o, totalMiles }) => <tr key={key(o)}><td><strong>{o.date} {o.time}</strong><small>{o.flightNumber}</small></td><td>{o.originLabel}<small>→ {o.destinationLabel}</small></td><td><span className={o.seats >= filters.passengers ? 'seats-available' : 'seats-empty'}>{o.seats}席</span></td><td>{totalMiles.toLocaleString('ja-JP')}</td><td>{clock(times.get(key(o))!)}<small>日本時間</small></td></tr>)}</tbody></table></div> : <p className="live-empty">{state === 'running' ? '回答の到着順に、条件に合う空席をここに表示します。' : rows.length ? '取得した回答では、希望人数を満たす空席がありません。「残席不足・0席も表示」で回答を確認できます。' : '条件に対応する空席回答をまだ取得できていません。'}</p>}
    </>}
  </section>
}
