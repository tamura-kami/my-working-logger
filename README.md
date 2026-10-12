# My Working Logger

個人用の作業時間記録アプリ。仕様は [docs/specification.md](docs/specification.md)。
React / TypeScript / Vite、Hono API、Workers Static Assets、D1 の実行基盤と3画面の枠を用意しています。作業管理・タイマー・集計の業務機能は後続 issue で実装します。

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

## Cloudflare Access と本番デプロイ（issue #2）

認証・許可判定は Cloudflare Access に任せます。アプリ内にはログイン画面、パスワード、ユーザー登録、独自の認証処理を作りません。Access はローカル開発には適用されません。ローカルの Vitest が通っても本番の Access 保護を確認したことにはならないため、以下の本番確認が必要です。

### 1. 公開経路を作らずに Worker を配置

必要なものは Cloudflare の Workers / D1 / Zero Trust を操作できるアカウントと、ログインに使うメールを受信できる端末です。独自ドメインは任意です。Zero Trust 未設定の場合はダッシュボードでチーム名などの初期設定を完了します。プラン・利用枠は契約時に確認してください。

```sh
npm ci
npx wrangler login
npx wrangler whoami
npx wrangler d1 create my-working-logger
```

出力された `database_id` を `wrangler.jsonc` に設定します。binding 名 `DB` と `migrations_dir` は維持します。次に本番 DB を初期化して配置します。

```sh
npm run db:migrate:remote
npm run deploy
```

`db:migrate:remote` は本番 DB への書き込みです。`deploy` は型検査・テスト・ビルド後に、フロントと API を単一 Worker として配置します。Cloudflare Vite plugin が生成した Wrangler 設定を利用するため、`dist/` を直接編集しません。

初期設定は `workers_dev: false`、`preview_urls: false`、カスタムドメイン・ルート指定なしです。新規 Worker の初回配置では HTTP の公開入口を作りません。これは未認証のアクセスを通す期間を避けるための準備状態であり、Access の代わりではありません。

既存 Worker に適用する場合は、先にダッシュボードの **Settings > Domains & Routes** とプレビュー設定を確認します。設定ファイルに書かれていない既存の経路が無効になると想定せず、すべての経路を保護するか無効化してください。公開経路を追加するのは、次の Access 設定が完了してからです。

### 2. 許可メールのポリシーを用意

1. Cloudflare ダッシュボードの **Zero Trust > Integrations > Identity providers** で **One-time PIN** を追加します。アプリ側にメール送信処理は不要です。
2. **Zero Trust > Access controls > Policies** で再利用できるポリシーを作成します（UI によっては Applications 内のポリシー編集から作成）。名前を `my-working-logger-owner`、Action を **Allow** とします。
3. **Include > Emails** に、アクセスを許可する自分のメールアドレスを完全一致で登録します。複数許可する場合もアドレスを個別指定します。メールドメイン全体や Everyone は選びません。
4. Allow に一致しない利用者は拒否されます。**Bypass**、**Service Auth**、Everyone やメールドメインを許可する別のポリシーは、この個人用アプリに追加しません。複数の Allow ポリシーがあると、別のポリシー経由でも許可されるためです。

### 3. Worker 全体に Access を適用

1. **Workers & Pages > my-working-logger > Access** を開き、**Protect this Worker behind Access** を選びます。
2. 対象を **All traffic**（本番とプレビューの両方）にします。**Previews only** では本番を保護できません。
3. Authentication policy に手順2の `my-working-logger-owner` を選択して **Apply Access** します。画面に完全一致メールの設定が出ない場合も、広い許可を代わりに選ばず、Zero Trust で作成したポリシーを指定します。
4. Zero Trust の該当 Access application を開き、対象がこの Worker 全体であること、Allow が手順2のポリシーだけであること、ログイン方式に One-time PIN が含まれることを確認します。セッション時間は初期運用では24時間を目安に設定します。

Worker 全体の Access は、関連する workers.dev、カスタムドメイン、ルート、プレビューの入口をまとめて対象にします。画面だけでなく `/api/*` と静的 JS/CSS も対象です。`/api/health` も例外にはしません。アプリで Access ヘッダーの有無だけを信用する認証は追加しません。

Worker 全体の設定が利用できない場合は、公開を保留し、[ホスト名単位の Access 設定](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)を使用します。Self-hosted application の対象はホスト全体（Path 空欄）にし、すべての公開ホストへ手順2のポリシーを適用します。プレビューは無効のままにします。API だけ、ルート画面だけを保護する設定では不十分です。

### 4. 保護設定後に公開入口を有効化

独自ドメインがなくても、以下の設定で利用できます。

1. `wrangler.jsonc` の `workers_dev` を `true` に変更します。`preview_urls` は `false` のままにします。
2. `npm run deploy` を実行し、表示された `https://my-working-logger.<account-subdomain>.workers.dev` を利用します。
3. **Domains & Routes** と **Access** をもう一度開き、公開された入口が手順3の保護対象であることを確認します。

独自ドメインを使う場合は、Cloudflare 管理下のドメインであることを確認し、Access 設定後に `wrangler.jsonc` に次のような実際のホスト名を設定して再配置します。例示のホスト名は置き換えてください。

```jsonc
"workers_dev": false,
"preview_urls": false,
"routes": [
  { "pattern": "logger.example.com", "custom_domain": true }
]
```

これで独自ドメインを入口とし、workers.dev を無効のままにできます。ダッシュボードだけで公開 URL の有効・無効を切り替えず、Wrangler の設定も一致させます。プレビューが必要になったら、先に **All traffic** の保護を確認してから有効化し、新しい URL でも以下の確認を繰り返してください。プレビューは本番 D1 を共有することがあるため、書き込み検証には別 Worker / 別 D1 を用意します。

### 5. 保護漏れと認証の確認方法

配置直後と公開経路・ポリシー変更後に、次の表を確認します。無効の経路は「無効」と記録し、未確認のまま合格扱いにしません。

| 公開されうる経路 | 確認対象 | 期待結果 |
| --- | --- | --- |
| workers.dev | `/`、`/summary`、`/projects`、`/api/health`、`/api`、`/api/missing` | 有効なら Access 保護、不要なら無効 |
| カスタムドメイン・既存ルートの全ホスト | 同上（ルート指定ならその配下） | すべて Access 保護 |
| Version URL・プレビュー・preview alias | 既存 URL、新しく生成された URL、各パス | 初期運用では無効。使う場合はすべて Access 保護 |
| 配置された JS/CSS | ログイン後の HTML から確認した実際の `/assets/...` | 未認証で取得できない |

未認証の確認では、Cookie や Access トークンを付けず、リダイレクトを追わずに GET します。以下の例のホスト名を実際の公開ホストに置き換え、表の全パスで実行します。

```sh
curl --silent --show-error --dump-header - --output /dev/null 'https://my-working-logger.<account-subdomain>.workers.dev/'
curl --silent --show-error --dump-header - --output /dev/null 'https://my-working-logger.<account-subdomain>.workers.dev/api/health'
```

Access のログイン URL へのリダイレクト、または Access による拒否を確認します。2xx でアプリの HTML、JS/CSS、health の JSON が返れば保護漏れです。アプリ自身の 404/503 や無関係なリダイレクトも、保護成功の証拠にはなりません。無効の入口は Worker の画面/API が返らないことと、ダッシュボード上の無効設定の両方で確認します。

ブラウザでも次を実施します。

- **未認証**: 新しいプライベートウィンドウで画面と API の URL に直接アクセスし、Access に止められることを確認。
- **許可ユーザー**: 許可メールで One-time PIN にログインしてタイマー画面に到達。画面の遷移・再読み込み、直接開いた `/api/health` の `200` と `{"status":"ok","database":"ok"}`、`/api/missing` の JSON 404 を確認。
- **未許可ユーザー**: 別のプライベートセッションで、許可一覧にない受信可能なメールを使ってログインを試みる。PIN が届かない場合も含め、画面・API が利用できないことを確認。PIN の発行有無だけで判定しない。
- **セッション終了**: `https://<公開ホスト>/cdn-cgi/access/logout` でログアウトし、画面と API を開き直して再認証が必要なことを確認。期限切れのセッションでも再認証されることを確認。

Zero Trust の Access ログで許可・拒否の結果とポリシーを照合します。PIN、Cookie、JWT、メールアドレスを含む認証ログをリポジトリに貼り付けないでください。

### 6. iPadOS 15 / Safari 15 の確認

実機の iPadOS バージョンを記録し、Safari で次を検証します。PC のエミュレーションだけでは合格としません。

- 未認証から Access のメール入力、PIN 受信・入力、タイマー画面への復帰まで完了する。
- リロードやタブを閉じて開き直した場合に、ログイン済みならタイマー画面に到達する。
- バックグラウンドからの復帰と、ログアウト・セッション期限切れ後の再ログインが完了する。
- 許可ユーザーの `/api/health` が正常に表示され、未許可ユーザーは拒否される。

現在のタイマー画面は枠のみです。作業選択・開始・停止・再開・終了・保存の確認は業務機能の実装後、issue #6 で行います。

### 確認記録と受け入れ条件

本番配置後に [確認記録テンプレート](docs/access-verification.md) の各項目を埋めます。issue #2 の受け入れには、本番での許可・未許可の画面/API 検証が必要です。現時点では設定手順と安全な初期公開設定を整備した段階であり、Cloudflare 設定および実機の結果は未確認です。

保護漏れがあれば公開入口を無効化してから、対象 Worker、All traffic、関連ホスト、Allow/Bypass ポリシーを見直します。health の503はログイン後に発生するなら、D1 ID・binding・本番マイグレーションの適用を確認します。再デプロイで認証問題を解消しようとして Access を外さないでください。

参考: [Workers の Access 設定](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)、[One-time PIN](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)、[Access ポリシー](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)、[Wrangler 設定](https://developers.cloudflare.com/workers/wrangler/configuration/)、[D1 マイグレーション](https://developers.cloudflare.com/d1/reference/migrations/)。

## 構成

- `src/`: フロント、CSS Modules、画面単位の遅延読み込み
- `worker/`: Hono API と Static Assets への委譲
- `migrations/`: D1 SQL（基盤用テーブルのみ。業務スキーマは後続 issue）
- `tests/`: Vitest / Miniflare による API と D1 のテスト
- `.github/workflows/check.yml`: push / PR の型検査・テスト・ビルド
