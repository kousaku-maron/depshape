# diffshape

git の差分の「形」を、push 前のローカルレビューで確かめるためのアプリです。どれも事実だけを見せ、判断はレビューする人に任せます。

1つのアプリの中に、見る対象ごとのモジュールが入っています。左のアイコンバーで切り替えます。

| モジュール | 内容 |
|---|---|
| [fileshape](packages/fileshape)（ファイル） | 変更された各ファイルの行の差分を、GitHub の Files changed と同じ形で見せます |
| [depshape](packages/depshape)（依存） | 差分でフォルダ・ファイル間の依存関係がどう変わったかを、既存の構造と並べて可視化します（Go / TypeScript / JavaScript） |
| [dbshape](packages/dbshape)（DB） | 差分で PostgreSQL のスキーマ（テーブル・カラム・制約・外部キー・CHECK の値）がどう変わったかを、ER 図の差分で見せます |

```bash
npx @kousaku-maron/diffshape . main --merge-base
```

使い方は [packages/diffshape](packages/diffshape) を見てください。

## パッケージ

| フォルダ | npm | 内容 |
|---|---|---|
| `packages/diffshape` | `@kousaku-maron/diffshape` | アプリ本体: CLI（`diffshape` / `fileshape` / `depshape` / `dbshape`）、ローカルサーバー、アイコンバーと共通ヘッダーのシェル |
| `packages/fileshape` | 非公開 | ファイルモジュール（行の差分と画面） |
| `packages/depshape` | 非公開 | 依存モジュール（解析と画面） |
| `packages/dbshape` | 非公開 | DB モジュール（解析と画面） |
| `packages/core` | 非公開 | Node 側の共通部分: git の読み取り（差分を含む）、比較対象の解決、ローカルサーバー、AI エージェントの起動、モジュールの決まり（`Analyzer`） |
| `packages/ui` | 非公開 | 画面側の共通部分: 色・基本スタイル、アイコン、1行目のバー、コメントの部品、表示の設定、モジュールの決まり（`ShapeModule`） |

非公開のパッケージは、`packages/diffshape` のビルドで1つにまとめて取り込みます。以前の単体パッケージ `@kousaku-maron/depshape`（0.3.0 まで）は npm に残っていますが、今後は diffshape に入っている `depshape` コマンドを使います。

### モジュールの決まり

モジュールは、サーバー側の `Analyzer`（比較を1つ受け取ってデータを返す）と、画面側の `ShapeModule`（アイコン・名前・画面・アイコンの件数）を出します。比較対象の解決、再読み込み、コメントの AI 用コピー、AI レビューと修正の実行はシェルが受け持ち、各モジュールは自分の画面だけを描きます。モジュールのスタイルは `[data-module="<id>"]` の中だけに効くように書きます。

- **git の読み取り**は `@diffshape/core` に集めます（`listFiles` / `readFiles` / `readBlob` / `diffPatch` / `untrackedFiles`）。モジュールは比較の両側（`Source`）を受け取って、これらで読みます
- **あとから読むデータ**（ファイル全体、画像など）は `Analyzer.api` にエンドポイントを足すと、`/api/module/<id>/<name>` で画面から呼べます
- **画面の共通部品**は `@diffshape/ui` にあります: 1行目のバー（`ModuleBar` と件数・確認済みの進み具合）、件数の表示、コメントのカードと入力欄、表示の設定（`loadPref` / `savePref`）、localStorage の読み書き
- **AI レビュー**: モジュールは `CommentReport.review` で「何が変わり、コメントは何を指せるか」をレビュー用プロンプトの一節として返し、シェルから届いたコメント（`ai`）のうち自分宛てで、指している先が実際にあるものだけを保存して `onAi` で件数を返します。エージェント（`claude` / `codex`）の検出と起動は `@diffshape/core` の `agent.ts` にあります
- 各モジュールは同じ並びのファイルを持ちます: `comments.ts`（コメントの状態と AI 用プロンプト）、`review.ts`（AI レビューに渡す一節と、返ってきたコメントの置き場所）、`CommentViews.tsx`、`reviewed.ts`（確認済みの印）、`<Name>View.tsx`、`styles.css`

## 開発

pnpm のワークスペースで管理しています（Node.js 20 以上）。

```bash
pnpm install
pnpm test        # 全パッケージのテスト
pnpm typecheck
pnpm build
```

アプリをローカルで動かすには、`packages/diffshape` をビルドして、解析したいリポジトリの中で実行します。

```bash
pnpm --filter @kousaku-maron/diffshape build
node /path/to/packages/diffshape/dist/bin/diffshape.js . main --merge-base
```

npm への公開は `packages/diffshape` のフォルダで `pnpm publish` を使います（`workspace:*` の依存を書き換えて公開するため。`npm publish` は使いません）。

## ライセンス

MIT（[LICENSE](LICENSE)）
