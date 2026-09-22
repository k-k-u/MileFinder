# ANA特典航空券の空席データAPI調査

調査日: 2026年9月22日。提供元の公式製品ページ・開発者仕様・ヘルプ・開発元が掲載したアプリ説明を確認した。サイトへの組み込みを想定し、ANA運航便とANA Mileage Clubの交換プログラムを区別した。

## 結論

**APIは存在する。MileFinderの試験導入候補はAwardWalletとAwardTool。** 両社とも特典航空券APIを提供し、ANA対応を示す公式掲載がある。ただしAPI認証情報は未取得であり、現行のANA国内線・国際線の実照会、必要人数の席数、会員条件、一般公開・CSV出力の許諾はまだ検証していない。

point.meにもANA Mileage Clubへの対応表記と法人向け組み込み製品があり、第3の確認先となる。これらの対応表記だけを根拠に、既存サイトを「実空席連携済み」とは扱わない。

## 優先して確認する3社

| 順位 | 提供元 | ANA対応の根拠 | 組み込み・料金 | 未確認事項 |
| --- | --- | --- | --- | --- |
| 1 | AwardWallet Flight Award Search API | API製品ページの「Supported Airline Programs」画像にANAロゴを掲載。画像も目視確認 | 公開REST仕様あり。API資格と価格・試験利用は問い合わせ | ANAのproviderコードと稼働状況、国内/国際範囲、会員ログイン条件、表示・保存・CSVの権利 |
| 2 | AwardTool Enterprise API | 開発元のApp Store説明がANA Mileage Clubを明示。企業向けAPIは同サービスの対応プログラムを対象と説明 | 自社製品への組み込み用API。プログラム単位の契約、従量またはコミット型の見積。承認後にキー発行 | ANAだけのライセンスの可否と価格、現在の対応範囲・精度、再表示・保存条件 |
| 3 | point.me Gateway | 公式Helpが検索結果の交換先にANA Mileage Clubを明示 | 法人向けAPIを軸とした特典検索・予約製品。法人料金は非公開 | 生データAPIだけの提供可否、AMC国内/国際範囲、検索量・権限・費用 |

### AwardWallet

[製品・試験利用案内](https://awardwallet.com/api/main)のFlight Award Search API節にANAの掲載がある。[掲載画像](https://d2xfav0ywhr7jn.cloudfront.net/assets/awardwalletnewdesign/img/flights-airlines.png)は上段4番目がANA。文字抽出では画像内容が省かれるため、対応表記の確認には画像を用いた。

[公式API仕様](https://awardwallet.com/api/flight-award-search)は、日付・区間・クラス・成人数で非同期検索し、マイル・税・旅程・取得できる場合の席数を返す。対応provider一覧は認証付きの `GET /v1/providers/list` で取得する。APIごとに対応providerが異なるため、残高照会APIやメール解析APIの対応一覧は代用できない。ANAの認証方式とカレンダー対応は、試験資格取得後に確認する。

価格とテストアクセスは製品ページから問い合わせる。公開サイトでの表示、保存期間、CSV出力、利用者の認証情報を扱う条件は契約時の確認対象。

### AwardTool

[Enterprise API](https://www.awardtool.com/enterprise-api)はリアルタイム検索とキャッシュ探索のPanoramaを提供し、検索サイトへの組み込みを用途に挙げる。対象API・プログラム・照会量により見積。個人向け会員契約とは別の製品。

[開発元のApp Store説明](https://apps.apple.com/us/app/awardtool/id6754333812)にANA Mileage Clubの記載がある。これは対応表記の根拠であり、今日のAPI稼働を実測した結果ではない。[公開開発者仕様](https://docs.awardtool.com/award-tool-api)は参照できるが、実行にはキーが必要。国内線と国際線の両方を対象にした試験が必要。

### point.me

[公式Help](https://connect.point.me/help/im-not-located-in-the-u.s.-but-want-to-utilize-point.me-is-that-possible)は、ANA Mileage Clubを検索結果の交換プログラム例として明示。[Gateway法人ページ](https://www.point.me/partnerships/)は企業ブランド内での特典検索・比較・予約を提供する。単独の空席データAPIとしてMileFinderから使用できる範囲と費用は未公表。個人向けサブスクリプションを法人API料金とみなさない。

## その他の候補

| 提供元 | 確認できたこと | 今回の判断 |
| --- | --- | --- |
| Seats.aero | 特典検索APIあり。公開されたソース一覧にANA Mileage Clubはない | 他社マイルから見えるANA便の補助検索用。AMCの直接空席として扱わない |
| PointsYeah | PremiumでAPIキー・1,000回/日を案内 | AMC直接対応と商用表示の許諾を確認できず、優先順位を下げる |
| AwardFares | ANA専用紹介ページで当該プログラム未対応と明示 | ANA特典の取得先には選ばない |
| Roame | 公開対応一覧にAMCなし。法人相談窓口はある | 今回のANA固有要件に適合する根拠が不足 |
| ExpertFlyer | AMC向け現行API・法人提供条件を確認できない | 現時点では候補選定の根拠不足 |
| ANA NDC | 公式Direct APIと旅行販売向け接続方法が存在 | ANAマイル特典空席APIとは確認できない |

Seats.aeroは[公式About](https://seats.aero/about)でProを月9.99米ドルと案内。[API利用条件](https://docs.seats.aero/article/68-seatsaero-pro-api-access-limits-and-usage)では対象Pro利用者の個人・非商用APIは1日1,000回、商用・本番利用には書面許諾、Live Search APIは法人契約が必要。地域・アカウントによりAPI資格がない場合もある。日本からの利用資格は契約前に確認する。[ソース一覧](https://developers.seats.aero/reference/concepts-copy)と[稼働状況一覧](https://seats.aero/status)にANA Mileage Clubは掲載されていない。

個人APIの検索はキャッシュが中心。[公式説明](https://docs.seats.aero/article/47-why-are-my-search-results-empty-or-missing-airlines)は収録路線・提携プログラム・人数・会員条件などにより結果が異なることを説明する。全路線網羅や取得時点での予約可能性を保証しない。[Login with Seats.aero](https://developers.seats.aero/reference/overview)による利用者単位の連携もあるが、AMC未掲載という点は解消しない。

その他の出典: [PointsYeah API](https://www.pointsyeah.com/developers)、[AwardFaresのANA対応状況](https://awardfares.com/programs/ana-mileage-club)、[Roame対応プログラム](https://roame.travel/about)、[Roame法人窓口・会員プラン](https://roame.travel/subscription)、[ExpertFlyer利用条件](https://www.expertflyer.com/terms)。

## ANA公式と他社プログラムの区別

[ANA NDC](https://www.ana.co.jp/businesspartners/ja/ndc/)にはDirect APIや旅行販売会社向けの接続案内があるが、マイル特典空席照会・マイル減算・特典発券への対応記載は確認できない。一般航空券の在庫APIを特典在庫APIとして流用できるとは判断しない。

[ANAの特典予約優先制度](https://www.ana.co.jp/ja/jp/amc/premium/service/priority-reservation/detail/)もあるため、照会に使う会員条件は確認が必要。すべての会員照会で在庫が異なると断定するものではない。

「ANA運航便」「Unitedで交換できるANA便」「ANA Mileage Clubで交換できるANA便」は別の属性。外部APIがUnited等の交換プログラムを返した場合、そのマイル数をANA表に置き換えるだけではANAでの予約可否を検証したことにならない。

[ANAサイト利用規約](https://www.ana.co.jp/ja/jp/guide/terms/website/)の利用者の義務20項には、許可のない商用目的の情報取得・二次利用についての制限がある。独自の画面自動取得を商用サイトの標準構成にする前には、対象となる条件・許可を確認する必要がある。法的評価や、すべての自動取得が禁止という断定は行っていない。

## MileFinderへの実装方針

1. AwardWalletとAwardToolに、ANAだけの試験アクセスと見積を確認する。問い合わせ下書きは [AVAILABILITY_API_INQUIRY.md](AVAILABILITY_API_INQUIRY.md)。
2. ANA国内線・国際線、複数人数、エコノミー・ビジネスを試し、同条件のANA公式結果と比較する。API障害・認証エラー・未収録と「空席なし」を区別する。
3. 取得プログラム名、便・区間・日付、マイル、税、席数の確実性、取得時刻を保持する。キャッシュには経過時間を表示する。APIのリクエスト受付時刻を実データ取得時刻と混同しない。
4. APIキーや必要な認証情報はサーバー側で管理する。複数路線・期間の一括探索は照会量を増やすため、キャッシュ・同時数・更新量を契約条件に合わせる。
5. 個別契約で認められた表示・保存・エクスポートだけを提供する。現在の候補計算機能は、実空席取得に失敗した際も「空席未照会」の意味で維持する。

今回は資料と対応表記の調査まで。APIキーの取得、契約、外部への問い合わせ送信、ANA会員情報の送信は実施していない。実空席検索の完成には試験アクセスと結果照合が残る。
