# 空席APIの問い合わせ下書き

2026年9月22日作成。**未送信**。日本語版を確認用、英語版を海外窓口への送信用として用意した。会社名・契約者名・連絡先・確約する照会量は未指定のため、作成者が送信前に補う。

問い合わせ先:

- [AwardWalletのAPI問い合わせ案内](https://awardwallet.com/api/main)から「Contact Us / Request an API Key」
- [AwardTool Enterprise APIのRequest API access](https://www.awardtool.com/enterprise-api)
- 必要に応じて[point.me Gatewayの法人窓口](https://www.point.me/partnerships/)

## 日本語版

件名: MileFinder向けANA Mileage Club特典空席APIの試験利用と見積の相談

ANAマイルで交換できる特典航空券を、出発地、目的地、日付範囲、座席クラス、人数、マイル予算から比較する日本語サイト「MileFinder」を開発しています。現在はローカルで動作する試作段階です。

ANA運航便を他社マイルで予約する在庫とは別に、ANA Mileage Clubのマイルで予約できる実空席を検索したいと考えています。以下についてご案内いただけますか。

1. 現在、ANA Mileage Clubを交換プログラムとしてAPIから直接検索できますか。日本国内線、国際線、提携航空会社特典のどこまで対応していますか。
2. 会員本人の認証は必要ですか。提供元側の認証で検索できる範囲、上級会員・カード会員条件、2段階認証への対応も教えてください。
3. 必要マイル、税・燃油サーチャージ、便名・区間・クラス、人数分の空席、実データ取得時刻を返せますか。不明な席数や空席待ちは区別されますか。
4. リアルタイム照会とキャッシュ検索の対象範囲、鮮度、日付範囲検索、レート制限、障害・未対応・空席なしの区別を教えてください。
5. 自サイトでの結果表示、キャッシュ保存、お気に入り、利用者によるCSV出力は許可されますか。必要な出典表記や保持期間、公開利用の制限も教えてください。
6. ANAだけを対象とする小規模な試験アクセス、最低料金、従量料金、最低契約期間、商用公開時の料金を教えてください。照会量は試験結果を基に決めたいと考えています。
7. ANA公式と同じ日付・区間・クラス・人数で結果照合できる、試験キーまたはサンプルレスポンスを提供できますか。

まずAPIの対応範囲と試験条件を確認したい段階です。よろしくお願いいたします。

## 英語版

Subject: ANA Mileage Club award availability API — trial access and pricing for MileFinder

Hello,

I am developing MileFinder, a Japanese-language website for comparing award flights redeemable with ANA Mileage Club miles by origin, destination, date range, cabin, passenger count, and mileage budget. It is currently a local prototype.

We need availability redeemable through ANA Mileage Club itself, rather than simply ANA-operated flights available through other loyalty programs. Could you please clarify the following?

1. Can your API currently search ANA Mileage Club directly? What is the coverage for Japan domestic awards, international awards, and partner-airline awards?
2. Are end-user ANA credentials required? Please explain provider-supplied authentication, elite/cardholder benefits, and two-factor authentication requirements.
3. Can responses include required miles, taxes and carrier surcharges, flight segments and cabins, availability for the requested passenger count, and the actual data retrieval timestamp? Are unknown seat counts and waitlists distinguishable?
4. What are the live and cached search coverage, freshness, date-range capabilities, and rate limits? How are errors, unsupported searches, and genuinely unavailable awards distinguished?
5. Does the license permit displaying results on our website, caching, saved favorites, and user-initiated CSV exports? What attribution, retention, and public-access restrictions apply?
6. Is a small-scale ANA-only trial available? Please share minimum fees, usage pricing, minimum contract terms, and pricing for a public commercial release. Expected request volume would be determined after evaluating the trial.
7. Could you provide test credentials or sample responses so we can compare results with ANA's website using matching routes, dates, cabins, and passenger counts?

We are evaluating coverage and trial terms before choosing a provider.

Thank you.
