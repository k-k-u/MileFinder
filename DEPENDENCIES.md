# 依存関係

2026年9月23日時点。正確な再現用バージョンは `package-lock.json` に固定しています。導入は `npm ci`、一覧の確認は `npm ls --depth=0`。

| ライブラリ・ツール | 検証バージョン | 用途 |
| --- | --- | --- |
| Node.js | 22.17.1 | 開発サーバー・ビルド・テストの実行 |
| npm | 10.9.2 | パッケージ管理 |
| React / React DOM | 19.3.0 | UIと状態管理 |
| TypeScript | 6.0.3 | 型チェック |
| Vite | 8.3.0 | 開発サーバー・静的ビルド |
| @vitejs/plugin-react | 6.1.1 | ViteのReact対応 |
| @cloudflare/vite-plugin | 1.57.3 | Reactの画面とCloudflare Workerのビルド・ローカル開発 |
| @openai/sites-vite-plugin | 0.2.0 | Sites設定を公開用ビルドへコピー |
| Wrangler | 4.136.3 | 公開用Workerのローカルプレビュー。配備そのものはSitesツールで実施 |
| @types/react / @types/react-dom | 19.3.0 | Reactの型定義 |
| @types/node | 22.20.4 | 空席照会サーバーとHTTP処理の型定義 |
| lucide-react | 1.47.0 | SVGアイコン |
| Vitest | 5.0.1 | マイル計算とデータ整合性の単体テスト |
| @playwright/test | 1.63.0 | ブラウザ操作のE2Eテスト |
| Microsoft Edge | インストール済み版 | E2E実行用のChromiumブラウザ。`edge://version` で確認 |
| Google Fonts | Web配信版 | Noto Sans JP / Plus Jakarta Sans。CSSから取得 |
| ChatGPT Sites | マネージドサービス | 公開画面・Workerの保存と配備。既存 `.openai/hosting.json` のproject IDを再利用 |
| Cloudflare Workers | Sites管理ランタイム | 公開APIと匿名チャット接続。Web標準のfetch・WebSocketを使用 |
| Cloudflare D1 | Sites管理SQLite | 会員照会の要求と検証済み結果の中継。ANAの認証情報は保存しない |

Node.js/npmはそれぞれ `node --version` / `npm --version` で確認できます。ローカル版ではNode.js標準のfetchとWebSocketでANA公式チャットへ接続します。公開版はSitesのWorkerで処理します。公開チャットの設定と一時トークンはサーバー内だけで扱います。

D1には会員照会の中継に必要な要求・検証済み結果を保存します。AMC会員番号・パスワード・ANAのCookie・応答HTMLは保存せず、ログイン済みANAタブ内だけで扱います。公開構成と運用手順は [DEPLOYMENT.md](DEPLOYMENT.md) を参照してください。
