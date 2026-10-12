# My Working Logger

個人用の作業時間記録アプリ。仕様は [docs/specification.md](docs/specification.md)。
issue #1 では React / TypeScript / Vite、Hono API、Workers Static Assets、D1 の実行基盤と3画面の枠を用意しています。作業管理・タイマー・集計の業務機能は後続 issue で実装します。

## ローカル開発

Node.js 22.12 以上（推奨: Node.js 22 LTS）と npm を使用します。Cloudflare アカウントへのログインはローカル開発には不要です。

```sh
npm ci
npm run db:migrate:local
npm run dev
```

表示された URL（通常 `http://127.0.0.1:5173`）で画面を開きます。同じオリジンの `/api/health` が `{"status":"ok","database":"ok"}` を返します。未マイグレーションの場合は 503 です。

- `/`: タイマー（Safari 15 必須対応の入り口）
- `/summary`: 実績・サマリ
- `/projects`: 作業管理

Cloudflare Vite plugin が実際の Workers ランタイムとローカル D1 を起動します。Vite と Wrangler は共通の `.wrangler/state` を使用し、ローカル DB は再起動後も保持されます。`db:migrate:local` は適用済みマイグレーションを再実行しません。本番 DB には接続しません。

## 検証・ビルド

```sh
npm run check
npm run preview
```

`check` はフロント・Worker・設定/テストの型検査、Vitest、ビルドを実行します。テストは独立した一時 D1 で未適用時のエラー、初期マイグレーション、health、API 404、静的ファイルへの委譲を確認します。`preview` はビルドした Worker と画面をローカルで動かします。

ブラウザ JS と CSS のビルド対象は Safari 15 です。画面は直接の動的 import で分割し、サマリや管理画面の依存をタイマーに静的 import しないでください。新しい Web API は対応状況を確認してから使用し、必要なら検出・代替処理を用意します。ビルド対象の指定だけでは Web API の互換性は保証されません。iPadOS 15 の Access ログインと実際の記録操作は後続 issue で実機検証します。

## 環境設定と秘密情報

`wrangler.jsonc` に Worker、Static Assets、D1 の設定を置きます。`DB` が D1 の binding 名です。現在の `database_id` はローカル開発用のダミーで、本番作成時に置き換えます。DB ID は秘密情報ではありません。

現時点でアプリの環境変数・秘密情報は不要です。将来ローカルの秘密情報が必要になったら `.dev.vars.example` を `.dev.vars` にコピーします。本番の秘密情報は `npx wrangler secret put 名前` で登録します。`.dev.vars*`、`.env*`、ローカル DB、ビルド成果物は git の対象外です（example ファイルを除く）。`VITE_` の値はブラウザへ公開されるので秘密情報を入れないでください。

## Cloudflare 側で必要な準備

ローカル開発だけなら操作は不要です。本番公開時には次の手順が必要です。

1. Cloudflare アカウントで Workers / D1 を利用できるようにし、端末で `npx wrangler login` を実行します。
2. `npx wrangler d1 create my-working-logger` で本番 DB を作成し、出力された `database_id` を `wrangler.jsonc` に設定します。binding 名 `DB` と `migrations_dir` は維持します。
3. `npm run db:migrate:remote` で本番マイグレーションを適用します（`--remote` は本番への書き込みです）。
4. Cloudflare Access で画面と `/api/*` を含むホスト全体を保護します。自分のメールアドレスなどに限定した Allow ポリシーを用意し、別の公開経路（workers.dev、preview URL）にも同じ保護を設定するか無効化します。Access の詳細な設定・検証は issue #2 の対象です。公開前にその作業を完了してください。
5. `npm run deploy` でフロントと API を単一 Worker に配置します。ビルド生成された Wrangler 設定は Cloudflare Vite plugin により利用されます。
6. ログアウト状態で画面と API が保護されること、ログイン後の画面と `/api/health` の応答を確認します。

参考: [Cloudflare Vite plugin](https://developers.cloudflare.com/workers/vite-plugin/get-started/)、[D1 マイグレーション](https://developers.cloudflare.com/d1/reference/migrations/)。

## 構成

- `src/`: フロント、CSS Modules、画面単位の遅延読み込み
- `worker/`: Hono API と Static Assets への委譲
- `migrations/`: D1 SQL（基盤用テーブルのみ。業務スキーマは後続 issue）
- `tests/`: Vitest / Miniflare による API と D1 のテスト
- `.github/workflows/check.yml`: push / PR の型検査・テスト・ビルド
