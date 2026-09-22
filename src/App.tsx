import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowDown, ArrowRight, ArrowUpRight, Bookmark, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Compass, Download, ExternalLink, Globe2, Info, List, MapPin, Plane, Search, Sparkles, Ticket, Users, Wallet, X } from 'lucide-react'
import { AIRPORTS, ROUTES, SOURCES, DATA_UPDATED_AT, type Cabin } from './data/awards'
import { addDays, defaults, exportCsv, searchAwards, sortResults, todayInTokyo, validateFilters, type SearchFilters, type SearchResult } from './lib/search'
import AvailabilityPanel from './AvailabilityPanel'
import MemberAvailabilityPanel from './MemberAvailabilityPanel'
import MemberWorkerPanel from './MemberWorkerPanel'
import type { MemberQuery } from './lib/anaMember'

const OFFICIAL_URL = 'https://www.ana.co.jp/ja/jp/guide/amc/award/'
const CABINS: Record<Cabin, string> = { economy: 'エコノミー', premium: 'プレミアムエコノミー', business: 'ビジネス', first: 'ファースト' }
const SEASONS = { L: 'ロー', R: 'レギュラー', H: 'ハイ' }
const number = (n: number) => n.toLocaleString('ja-JP')
const dateLabel = (s: string, weekday = false) => new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', ...(weekday ? { weekday: 'short' as const } : {}), timeZone: 'UTC' }).format(new Date(`${s}T00:00:00Z`))
const regionNames = [...new Set(ROUTES.map(r => r.region))]
const originCodes = new Set(ROUTES.map(r => r.origin))
const originAirports = AIRPORTS.filter(a => originCodes.has(a.code))
type SavedSearch = { id: string; routeId: string; filters: SearchFilters }
type ResultEntry = { result: SearchResult; filters: SearchFilters; key: string }
const entryKey = (routeId: string, f: SearchFilters) => [routeId, f.dateFrom, f.dateTo, f.tripType, f.nights, f.cabin, f.passengers, f.budget].join(':')

function initialFilters(): SearchFilters {
  try {
    const encoded = new URLSearchParams(location.search).get('search')
    if (encoded) {
      const candidate = { ...defaults(), ...JSON.parse(encoded) }
      if (!Object.keys(validateFilters(candidate)).length) return candidate
    }
  } catch { /* 壊れた共有URLは既定条件で開く */ }
  return defaults()
}

function readSaved(): SavedSearch[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem('milefinder:saved:v1') ?? '[]')
    if (!Array.isArray(value)) return []
    return value.filter((x): x is SavedSearch => !!x && typeof x === 'object' && typeof x.id === 'string' && typeof x.routeId === 'string' && !!x.filters && Object.keys(validateFilters(x.filters, x.filters.dateFrom)).length === 0).slice(0, 100)
  } catch { return [] }
}

function Dialog({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => { dialog?.close() } }, [])
  return <dialog ref={ref} aria-labelledby={titleId} className={`dialog ${wide ? 'dialog-wide' : ''}`} onCancel={onClose} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
    <div className="dialog-head"><h2 id={titleId}>{title}</h2><button className="icon-button" onClick={onClose} aria-label="閉じる"><X size={21} /></button></div>
    <div className="dialog-body">{children}</div>
  </dialog>
}

function HeroArt() {
  return <div className="hero-art" aria-hidden="true">
    <svg className="flight-art" viewBox="0 0 520 250" fill="none">
      <defs><radialGradient id="glow"><stop stopColor="#dce8ff" /><stop offset="1" stopColor="#f7f8fa" stopOpacity="0" /></radialGradient><pattern id="dots" width="15" height="15" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1" fill="#c8d5ea" /></pattern></defs>
      <ellipse cx="280" cy="133" rx="227" ry="128" fill="url(#glow)" />
      <ellipse cx="306" cy="135" rx="170" ry="103" fill="url(#dots)" transform="rotate(-13 306 135)" />
      <ellipse cx="300" cy="128" rx="196" ry="81" stroke="#dbe4f2" transform="rotate(-23 300 128)" />
      <path d="M85 180C164 39 339 28 432 97" stroke="#6c94ee" strokeWidth="1.5" strokeDasharray="5 6" />
      <circle cx="85" cy="180" r="5" fill="#285fdf" /><circle cx="85" cy="180" r="12" stroke="#285fdf" strokeOpacity=".16" strokeWidth="6" />
      <circle cx="432" cy="97" r="5" fill="#285fdf" /><circle cx="432" cy="97" r="13" stroke="#285fdf" strokeOpacity=".13" strokeWidth="7" />
    </svg>
    <div className="art-label art-tokyo"><span>TYO</span><small>TOKYO</small></div>
    <div className="art-label art-world"><span>ANYWHERE</span><small>次の目的地は、自由に。</small></div>
    <div className="plane-bubble"><Plane size={31} strokeWidth={1.6} /></div>
    <div className="art-tag"><Sparkles size={13} /> マイルが、旅のきっかけに。</div>
  </div>
}

function RouteCard({ entry, saved, onSave, onOpen }: { entry: ResultEntry; saved: boolean; onSave: () => void; onOpen: () => void }) {
  const { result: r, filters: f } = entry
  return <article className="route-card">
    <div className={`destination-symbol region-${r.route.kind}`}><Globe2 size={25} strokeWidth={1.35} /><span>{r.destination.code}</span></div>
    <div className="route-info"><div className="route-meta"><span>{r.route.region}</span><span className="meta-dot">·</span><span>{r.destination.country}</span></div>
      <h3>{r.destination.city}{r.destination.name !== r.destination.city && <small>{r.destination.name}</small>}</h3>
      <div className="route-path"><span>{r.origin.code}</span><span className="path-line" /><Plane size={13} /><span className="path-line" /><span>{r.destination.code}</span><span className="route-cabin">{CABINS[f.cabin]}</span></div>
    </div>
    <div className="route-dates"><span className="small-label">最少マイルの出発日</span><strong>{dateLabel(r.cheapest.departureDate, true)}</strong><span>{r.options.length}日分の候補 <span className={`season-label season-${r.cheapest.departureSeason}`}>{SEASONS[r.cheapest.departureSeason]}</span></span></div>
    <div className="route-price"><div><strong>{number(r.minMiles)}</strong><span> マイル〜</span></div><small>{f.passengers}名・{f.tripType === 'oneway' ? '片道' : '往復'}の合計</small><button className="details-button" onClick={onOpen}>日付と詳細 <ArrowRight size={15} /></button></div>
    <button className={`save-button ${saved ? 'is-saved' : ''}`} onClick={onSave} aria-label={`${r.destination.city}を${saved ? '保存から削除' : '保存'}`} aria-pressed={saved}><Bookmark size={19} fill={saved ? 'currentColor' : 'none'} /></button>
  </article>
}

function SearchApp() {
  const [filters, setFilters] = useState<SearchFilters>(initialFilters)
  const [applied, setApplied] = useState(filters)
  const [response, setResponse] = useState(() => searchAwards(filters))
  const [errors, setErrors] = useState<ReturnType<typeof validateFilters>>({})
  const [saved, setSaved] = useState<SavedSearch[]>(readSaved)
  const [tab, setTab] = useState<'search' | 'saved'>('search')
  const [view, setView] = useState<'list' | 'calendar'>('list')
  const [sort, setSort] = useState<'miles' | 'destination' | 'dates'>('miles')
  const [region, setRegion] = useState('all')
  const [selected, setSelected] = useState<ResultEntry | null>(null)
  const [help, setHelp] = useState(false)
  const [toast, setToast] = useState('')
  const [calendarPage, setCalendarPage] = useState(0)
  const [limit, setLimit] = useState(12)
  const resultsRef = useRef<HTMLElement>(null)
  const today = todayInTokyo()
  const latest = addDays(today, 355)
  const dirty = JSON.stringify(filters) !== JSON.stringify(applied)

  useEffect(() => {
    try { localStorage.setItem('milefinder:saved:v1', JSON.stringify(saved)) }
    catch { setToast('このブラウザでは保存を記録できません。現在の画面内では利用できます。') }
  }, [saved])
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 4500); return () => clearTimeout(timer) }, [toast])

  const savedEntries = useMemo(() => saved.flatMap(s => {
    const r = searchAwards(s.filters).results.find(r => r.route.id === s.routeId)
    return r ? [{ result: r, filters: s.filters, key: s.id }] : []
  }), [saved])
  const allEntries: ResultEntry[] = tab === 'saved' ? savedEntries : sortResults(response.results, sort).map(r => ({ result: r, filters: applied, key: entryKey(r.route.id, applied) }))
  const entries = allEntries.filter(e => region === 'all' || e.result.route.region === region)
  const resultRegions = [...new Set(allEntries.map(e => e.result.route.region))]
  const allDates = [...new Set(entries.flatMap(e => e.result.options.map(o => o.departureDate)))].sort()
  const shownDates = allDates.slice(calendarPage * 7, calendarPage * 7 + 7)
  const visibleEntries = entries.slice(0, limit)
  const optionsCount = entries.reduce((n, e) => n + e.result.options.length, 0)

  function update<K extends keyof SearchFilters>(key: K, value: SearchFilters[K]) { setFilters(f => ({ ...f, [key]: value })); setErrors(e => ({ ...e, [key]: undefined })) }
  function useMemberQuery(query: MemberQuery) {
    const nights = Math.round((Date.parse(query.returnDate) - Date.parse(query.departureDate)) / 86_400_000)
    const route = ROUTES.find(r => r.kind === 'international' && r.destination === query.destination)
    const next: SearchFilters = { ...filters, kind: 'international', origin: query.origin, region: route?.region ?? 'all', dateFrom: query.departureDate, dateTo: query.departureDate, tripType: 'roundtrip', nights, cabin: query.cabin, passengers: query.passengers }
    if (Object.keys(validateFilters(next)).length) return
    setFilters(next); setApplied(next); setResponse(searchAwards(next)); setErrors({}); setTab('search'); setRegion('all')
    setToast('ANA会員画面の検索条件を反映しました')
  }
  function submit(e: FormEvent) {
    e.preventDefault()
    const checked = validateFilters(filters)
    setErrors(checked)
    if (Object.keys(checked).length) return
    setApplied({ ...filters }); setResponse(searchAwards(filters)); setTab('search'); setRegion('all'); setCalendarPage(0); setLimit(12)
    const url = new URL(location.href); url.searchParams.set('search', JSON.stringify(filters)); history.replaceState(null, '', url)
    setToast('条件に合う候補を更新しました')
    if (window.innerWidth < 760) resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  function toggleSaved(entry: ResultEntry) {
    if (saved.some(s => s.id === entry.key)) { setSaved(a => a.filter(s => s.id !== entry.key)); setToast('保存した候補から削除しました') }
    else if (saved.length >= 100) setToast('保存できる候補は100件までです。不要な候補を削除してください。')
    else { setSaved(a => [...a, { id: entry.key, routeId: entry.result.route.id, filters: entry.filters }]); setToast('候補と検索条件を保存しました') }
  }
  function download() {
    const blob = new Blob([exportCsv(entries.map(e => e.result))], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `milefinder-${today}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
    setToast(`${number(optionsCount)}件の日付別候補をCSVに出力しました`)
  }
  function chooseTab(next: 'search' | 'saved') { setTab(next); setRegion('all'); setLimit(12); setCalendarPage(0) }
  const fieldError = (key: keyof SearchFilters) => errors[key] ? <span className="field-error" role="alert">{errors[key]}</span> : null

  return <>
    <header className="site-header"><div className="header-inner">
      <a className="brand" href="/" aria-label="MileFinder ホーム"><span className="brand-icon"><Plane size={21} /></span>Mile<span>Finder</span><span className="brand-beta">BETA</span></a>
      <nav className="main-nav" aria-label="メインナビゲーション"><button className={tab === 'search' ? 'active' : ''} onClick={() => chooseTab('search')}><Search size={16} />特典航空券を探す</button><button className={tab === 'saved' ? 'active' : ''} onClick={() => chooseTab('saved')}><Bookmark size={16} />保存した候補{saved.length > 0 && <span className="count-badge">{saved.length}</span>}</button></nav>
      <button className="help-link" aria-label="使い方" onClick={() => setHelp(true)}><CircleHelp size={17} /><span>使い方</span></button>
    </div></header>
    <main className="main-container">
      <section className="hero"><div className="hero-copy"><div className="eyebrow"><span /> ANA MILEAGE, MORE POSSIBILITIES</div><h1>そのマイルで、<br />どこへ行こう<span className="blue-period">。</span></h1><p>行き先は、まだ決めなくていい。<br />日程とマイルから、あなたの次の旅を見つけよう。</p></div><HeroArt /></section>

      <form className="search-panel" onSubmit={submit} noValidate aria-label="特典航空券の検索条件">
        <div className="search-top"><div className="kind-tabs" aria-label="路線の種類">{([['all', 'すべての路線'], ['international', '国際線'], ['domestic', '国内線']] as const).map(([value, label]) => <button type="button" aria-pressed={filters.kind === value} className={filters.kind === value ? 'selected' : ''} key={value} onClick={() => update('kind', value)}>{value === 'all' && <Globe2 size={16} />}{label}</button>)}</div><div className="trip-switch">{([['oneway', '片道'], ['roundtrip', '往復']] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={filters.tripType === value} className={filters.tripType === value ? 'selected' : ''} onClick={() => update('tripType', value)}>{label}</button>)}</div></div>
        <div className="search-fields">
          <label className="field"><span><MapPin size={14} /> 出発地</span><div className="select-wrap"><select value={filters.origin} onChange={e => update('origin', e.target.value)} aria-label="出発地"><option value="TYO">東京（羽田・成田）</option><option value="ALL">すべての出発地</option>{originAirports.map(a => <option key={a.code} value={a.code}>{a.city} / {a.name}（{a.code}）</option>)}</select><ChevronDown size={15} /></div>{fieldError('origin')}</label>
          <label className="field"><span><Globe2 size={14} /> 行き先</span><div className="select-wrap"><select value={filters.region} onChange={e => update('region', e.target.value)} aria-label="行き先"><option value="all">どこでも</option>{regionNames.map(r => <option key={r}>{r}</option>)}</select><ChevronDown size={15} /></div>{fieldError('region')}</label>
          <div className="field date-field"><span><CalendarDays size={14} /> 出発日の範囲 <small>最大62日</small></span><div className="date-inputs"><input aria-label="出発日の開始" type="date" min={today} max={latest} value={filters.dateFrom} onChange={e => update('dateFrom', e.target.value)} /><span>—</span><input aria-label="出発日の終了" type="date" min={filters.dateFrom || today} max={latest} value={filters.dateTo} onChange={e => update('dateTo', e.target.value)} /></div>{fieldError('dateFrom')}{fieldError('dateTo')}</div>
          <label className="field budget-field"><span><Wallet size={14} /> 使えるマイル <small>全員の合計</small></span><div className="budget-input"><input aria-label="使えるマイル" type="number" min="1" step="1000" value={Number.isFinite(filters.budget) ? filters.budget : ''} onChange={e => update('budget', e.target.value === '' ? NaN : Number(e.target.value))} /><span>マイル</span></div>{fieldError('budget')}</label>
        </div>
        <div className="search-bottom"><div className="secondary-fields"><label><Users size={15} /><select aria-label="人数" value={filters.passengers} onChange={e => update('passengers', Number(e.target.value))}>{Array.from({ length: 9 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}名</option>)}</select></label><span className="field-divider" /><label><Ticket size={15} /><select aria-label="座席クラス" value={filters.cabin} onChange={e => update('cabin', e.target.value as Cabin)}>{Object.entries(CABINS).map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select></label>{filters.tripType === 'roundtrip' && <><span className="field-divider" /><label><CalendarDays size={15} /><select aria-label="旅行日数" value={filters.nights} onChange={e => update('nights', Number(e.target.value))}>{Array.from({ length: 30 }, (_, i) => <option value={i + 1} key={i + 1}>出発日の{i + 1}日後に復路</option>)}</select></label></>}</div><button type="submit" className="primary-button"><Search size={18} />この条件で探す<ArrowRight size={17} /></button></div>
        {(errors.cabin || errors.nights || errors.passengers || errors.kind || errors.tripType) && <div className="extra-errors" role="alert">{errors.cabin}{errors.nights}{errors.passengers}{errors.kind}{errors.tripType}</div>}
      </form>
      <div className="search-note"><Info size={14} /><span>ANA公式の必要マイル表から算出した候補です。空席・運航日・搭乗クラスの提供はANA公式でご確認ください。</span><button onClick={() => setHelp(true)}>データについて <ArrowUpRight size={12} /></button></div>

      {tab === 'search' && <AvailabilityPanel key={JSON.stringify(applied)} results={response.results} filters={applied} />}
      {tab === 'search' && <MemberAvailabilityPanel filters={applied} onConnected={useMemberQuery} />}

      <section ref={resultsRef} className="results-section" aria-label="検索結果">
        <div className="results-heading"><div><div className="section-eyebrow">{tab === 'saved' ? 'YOUR SHORTLIST' : 'FIND YOUR NEXT DESTINATION'}</div><h2>{tab === 'saved' ? '保存した旅の候補' : 'マイルで広がる、旅の候補'}<span className="result-count">{entries.length}<small>路線</small></span></h2></div><button className="export-button" onClick={download} disabled={!entries.length}><Download size={16} />CSV出力</button></div>
        <div className="result-summary"><span>{tab === 'search' ? <>{dateLabel(applied.dateFrom)} — {dateLabel(applied.dateTo)}<span className="summary-divider">/</span>{CABINS[applied.cabin]}<span className="summary-divider">/</span>{applied.passengers}名・{applied.tripType === 'oneway' ? '片道' : '往復'}</> : '保存時の検索条件で表示しています'}<span className="summary-divider">·</span>{number(optionsCount)}件の日付別候補</span>{dirty && tab === 'search' && <span className="pending-label">条件を変更しました。「この条件で探す」で更新</span>}</div>
        {tab === 'search' && response.warnings.length > 0 && <div className="warning-box"><Info size={16} /><div>{response.warnings.map(w => <p key={w}>{w}</p>)}</div></div>}
        {tab === 'saved' && saved.length > savedEntries.length && <div className="warning-box"><Info size={16} /><div><p>{saved.length - savedEntries.length}件は日付や公開データの対象外になっています。</p><button onClick={() => setSaved(saved.filter(s => savedEntries.some(e => e.key === s.id)))}>対象外の保存を削除</button></div></div>}
        <div className="results-toolbar"><div className="region-chips" aria-label="結果の方面絞り込み"><button className={region === 'all' ? 'active' : ''} onClick={() => { setRegion('all'); setCalendarPage(0); setLimit(12) }}>すべて<span>{allEntries.length}</span></button>{resultRegions.map(r => <button key={r} className={region === r ? 'active' : ''} onClick={() => { setRegion(r); setCalendarPage(0); setLimit(12) }}>{r}</button>)}</div><div className="result-controls">{tab === 'search' && <label className="sort-select"><ArrowDown size={13} /><select aria-label="並び順" value={sort} onChange={e => setSort(e.target.value as typeof sort)}><option value="miles">マイルが少ない順</option><option value="destination">目的地の名前順</option><option value="dates">候補日が多い順</option></select></label>}<div className="view-toggle"><button aria-label="リスト表示" aria-pressed={view === 'list'} className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}><List size={17} /></button><button aria-label="カレンダー表示" aria-pressed={view === 'calendar'} className={view === 'calendar' ? 'active' : ''} onClick={() => setView('calendar')}><CalendarDays size={17} /></button></div></div></div>
        <div className="availability-note"><span className="unconfirmed-dot" />空席は未照会<span>表示マイルに税金・燃油サーチャージ等は含みません</span></div>
        {entries.length === 0 ? <div className="empty-state"><div><Compass size={34} strokeWidth={1.4} /></div><h3>{tab === 'saved' ? '気になる行き先を、ここに。' : '条件に合う候補が見つかりませんでした'}</h3><p>{tab === 'saved' ? '候補のブックマークを押すと、検索条件と一緒に保存できます。' : 'マイルの上限、日付、出発地、座席クラスを変えて探してみてください。'}</p><button className="secondary-button" onClick={() => { if (tab === 'saved') chooseTab('search'); else { const f = defaults(); setFilters(f); setApplied(f); setResponse(searchAwards(f)); setErrors({}); setRegion('all'); const url = new URL(location.href); url.searchParams.delete('search'); history.replaceState(null, '', url) } }}>{tab === 'saved' ? '旅の候補を探す' : '条件をリセット'}<ArrowRight size={16} /></button></div> : view === 'list' ? <div className="route-list">{visibleEntries.map(entry => <RouteCard key={entry.key} entry={entry} saved={saved.some(s => s.id === entry.key)} onSave={() => toggleSaved(entry)} onOpen={() => setSelected(entry)} />)}</div> : <div className="calendar-panel"><div className="calendar-top"><span><CalendarDays size={17} />日付ごとの必要マイル <small>全員・旅程合計</small></span><div><button className="icon-button" aria-label="前の7日" disabled={calendarPage === 0} onClick={() => setCalendarPage(p => p - 1)}><ChevronLeft size={18} /></button><span>{shownDates[0] && dateLabel(shownDates[0])} — {shownDates.at(-1) && dateLabel(shownDates.at(-1)!)}</span><button className="icon-button" aria-label="次の7日" disabled={(calendarPage + 1) * 7 >= allDates.length} onClick={() => setCalendarPage(p => p + 1)}><ChevronRight size={18} /></button></div></div><div className="table-scroll"><table className="calendar-table"><thead><tr><th>行き先</th>{shownDates.map(date => <th key={date}>{dateLabel(date, true)}</th>)}</tr></thead><tbody>{visibleEntries.map(entry => <tr key={entry.key}><th><button onClick={() => setSelected(entry)}>{entry.result.destination.city}<small>{entry.result.origin.code} → {entry.result.destination.code}</small></button></th>{shownDates.map(date => { const o = entry.result.options.find(o => o.departureDate === date); return <td key={date}>{o ? <button className={`calendar-cell season-${o.departureSeason}`} onClick={() => setSelected(entry)} aria-label={`${entry.result.destination.city} ${date} ${number(o.totalMiles)}マイル 詳細`}>{number(o.totalMiles)}<small>{SEASONS[o.departureSeason]}</small></button> : <span className="no-result" title="予算・公開データの対象外">—</span>}</td> })}</tr>)}</tbody></table></div></div>}
        {entries.length > limit && <button className="load-more" onClick={() => setLimit(n => n + 12)}>さらに12路線を見る<span>残り{entries.length - limit}路線</span><ChevronDown size={16} /></button>}
        {entries.length > 0 && <div className="results-foot"><span>{Math.min(limit, entries.length)} / {entries.length}路線を表示</span><span><Check size={13} />公開マイル表をもとに計算</span></div>}
      </section>
      <section className="bottom-banner"><div className="banner-icon"><Plane size={22} /></div><div><h3>行きたい場所が見つかったら。</h3><p>最新の空席をANA公式で確認して、次の旅へ。</p></div><a href={OFFICIAL_URL} target="_blank" rel="noreferrer">ANA公式で空席を確認 <ArrowUpRight size={17} /></a></section>
    </main>
    <footer className="site-footer"><div><span className="footer-brand"><Plane size={16} />MileFinder</span><p>マイルからはじまる、まだ見ぬ旅。</p></div><div><button onClick={() => setHelp(true)}>使い方・データの出典</button><p>ANA非公式サービス · データ確認日 {DATA_UPDATED_AT}</p></div></footer>
    {toast && <div className="toast" role="status"><Check size={17} />{toast}</div>}
    {selected && <Dialog title={`${selected.result.origin.city}から${selected.result.destination.city}へ`} onClose={() => setSelected(null)} wide>
      <div className="detail-route"><span>{selected.result.origin.code}<small>{selected.result.origin.name}</small></span><div><Plane size={25} /><small>{selected.filters.tripType === 'oneway' ? '片道' : '往復'} · {CABINS[selected.filters.cabin]}</small></div><span>{selected.result.destination.code}<small>{selected.result.destination.name}</small></span></div>
      <div className="detail-status"><Info size={16} /><p>空席は未照会です。この路線の運航日・搭乗クラスの提供も含め、ANA公式でご確認ください。税金・燃油サーチャージ等は別途必要です。</p></div>
      <div className="detail-stats"><div><span>最少の必要マイル</span><strong>{number(selected.result.minMiles)}<small> マイル</small></strong></div><div><span>人数・旅程</span><strong>{selected.filters.passengers}名<small> / {selected.filters.tripType === 'oneway' ? '片道' : `往復・${selected.filters.nights}日後に復路`}</small></strong></div></div>
      <h3 className="detail-heading">日付別の候補 <span>{selected.result.options.length}日分</span></h3>
      <div className="detail-table-wrap"><table className="detail-table"><thead><tr><th>出発日</th>{selected.filters.tripType === 'roundtrip' && <th>復路出発日</th>}<th>シーズン</th><th>1名あたり</th><th>全員の合計</th></tr></thead><tbody>{selected.result.options.map(o => <tr key={o.departureDate}><td>{dateLabel(o.departureDate, true)}</td>{o.returnDate && <td>{dateLabel(o.returnDate, true)}</td>}<td><span className={`season-label season-${o.departureSeason}`}>{SEASONS[o.departureSeason]}</span>{o.returnSeason && <> / <span className={`season-label season-${o.returnSeason}`}>{SEASONS[o.returnSeason]}</span></>}</td><td>{number(o.milesPerPerson)}</td><td><strong>{number(o.totalMiles)}</strong></td></tr>)}</tbody></table></div>
      <div className="source-links"><span>計算に使用した公式情報</span>{SOURCES.filter(s => selected.result.route.sourceIds.includes(s.id)).map(s => <a key={s.id} href={s.url} target="_blank" rel="noreferrer">{s.title}<ExternalLink size={12} /></a>)}</div>
      <div className="detail-actions"><button className="secondary-button" onClick={() => toggleSaved(selected)}><Bookmark size={16} fill={saved.some(s => s.id === selected.key) ? 'currentColor' : 'none'} />{saved.some(s => s.id === selected.key) ? '保存済み' : 'この候補を保存'}</button><a className="primary-button" href={OFFICIAL_URL} target="_blank" rel="noreferrer">ANA公式で空席確認<ArrowUpRight size={17} /></a></div><p className="detail-footnote">ANA公式ではログイン後に、この日付・区間・人数を入力してください。</p>
    </Dialog>}
    {help && <Dialog title="MileFinderについて" onClose={() => setHelp(false)}>
      <div className="help-intro"><span className="brand-icon"><Plane size={23} /></span><p>貯めたマイルから、旅の可能性を探す。<br />ANA特典航空券の候補をまとめて比較するツールです。</p></div>
      <div className="help-step"><span>01</span><div><h3>日程とマイルを入力</h3><p>出発地、方面、最大62日間の出発期間、全員で使えるマイルを選びます。往復は復路出発日までの日数を指定します。</p></div></div>
      <div className="help-step"><span>02</span><div><h3>候補をまとめて比較</h3><p>公開された必要マイル表とシーズンから、予算内の路線・日付を計算。保存した候補はこのブラウザに記録され、CSVでは全候補日を出力できます。</p></div></div>
      <div className="help-step"><span>03</span><div><h3>国際線の実空席を一括照会</h3><p>「空席をまとめて照会」でANA公式チャットの実回答を取得します。国際線の直行便が対象で、未ログイン時の席数を表示します。往復は両便の空席を個別に調べ、同じ空港へ戻る組み合わせを表示します。会員向け優先枠や旅程全体の予約可否、諸費用はANA公式予約画面で確認してください。マイルから算出した「候補」は空席確認済みとは限りません。</p></div></div>
      <div className="help-step"><span>04</span><div><h3>ログイン済みの会員検索に接続</h3><p>「ANA会員の空席照会」の案内からANAのフライト一覧に接続できます。国際線の往復・エコノミー・成人が対象です。接続した路線の日付と人数を最大7日ずつ照会し、会員画面が返した往復の組み合わせ、全員分のマイルと税金等を表示します。ANAのタブを開いたまま使い、予約・発券は公式画面で行ってください。</p></div></div>
      <div className="help-notice"><h3>検索対象と計算について</h3><p>収録したANA国内線・国際線の直行区間を対象とします。提携航空会社、乗り継ぎ、キャンペーン、幼児割引は含みません。国内線はエコノミークラスが対象です。座席を使う利用者は全員同額で計算します。</p><p>往復は往路・復路の各出発日の必要マイルを合計します。シーズンが未公表の日付は結果に含めません。路線ごとの運航曜日や搭乗クラスの供給は反映していません。予約受付時刻・締切にも従います。</p></div>
      <div className="source-links"><h3>データの出典</h3><p>確認日：{DATA_UPDATED_AT} · ANA公式の公開情報</p>{SOURCES.map(s => <a key={s.id} href={s.url} target="_blank" rel="noreferrer">{s.title}<ExternalLink size={13} /></a>)}</div>
      <p className="help-legal">MileFinderはANAグループが提供・運営するサービスではありません。検索条件を含むURLを共有すると、相手にも同じ条件が表示されます。AMC番号やパスワードの入力・保存は行いません。</p>
    </Dialog>}
  </>
}

export default function App() {
  return ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) && new URLSearchParams(location.search).has('member-worker')
    ? <MemberWorkerPanel /> : <SearchApp />
}
