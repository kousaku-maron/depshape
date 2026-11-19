# diffshape

git の差分の「形」を、push 前のローカルレビューで確かめるためのアプリです。差分を3つの見方で、ブラウザに並べて見せます。

- **ファイル**（[fileshape](https://github.com/kousaku-maron/diffshape/tree/main/packages/fileshape)）: 変更された各ファイルの行の差分を、GitHub の Files changed と同じ形で見せます
- **依存**（[depshape](https://github.com/kousaku-maron/diffshape/tree/main/packages/depshape)）: フォルダ・ファイル間の依存関係がどう変わったかを、既存の構造と並べて見せます（Go / TypeScript / JavaScript）
- **DB**（[dbshape](https://github.com/kousaku-maron/diffshape/tree/main/packages/dbshape)）: PostgreSQL のスキーマ（テーブル・カラム・制約・外部キー・CHECK の値）がどう変わったかを、ER 図の差分で見せます

どれも git から直接ファイルを読みます。ビルドツールのインストール、DB への接続、外部サービスは要りません。事実だけを見せ、判断はレビューする人が行います。手元に Claude Code か Codex があれば、同じ画面からレビューと修正を任せることもできます（「AI レビューと修正」）。

## 使い方

解析したいリポジトリの中で実行します（Node.js 20 以上と git が必要です）。

```bash
npx @kousaku-maron/diffshape . main --merge-base
```

よく使うなら `npm install -g @kousaku-maron/diffshape` で入れておくと、次の4つのコマンドが使えます。

| コマンド | 開くもの |
|---|---|
| `diffshape` | ファイル・依存・DB のすべて（左のアイコンバーで切り替え） |
| `fileshape` | ファイルだけ（`--json` で差分を標準出力へ） |
| `depshape` | 依存だけ（`--json` で解析結果を標準出力へ） |
| `dbshape` | DB だけ（`--text` で要約、`--json` で差分を標準出力へ） |

比較の指定はどれも同じです。

| 例 | 比較内容 |
|---|---|
| `diffshape` | 未コミットの変更すべて vs HEAD |
| `diffshape . main --merge-base` | 現在の作業ディレクトリ vs main からの分岐点（GitHub の PR と同じ見え方） |
| `diffshape @ main --merge-base` | HEAD（コミット済み）vs main からの分岐点 |
| `diffshape abc1234` | そのコミット単体の変更 |
| `diffshape staged` / `diffshape working` | ステージ済み / 未ステージの変更のみ |

オプション: `--merge-base`、`--schema <glob>`（スキーマの SQL ファイル。省略時はリポジトリ内のすべての `atlas.hcl` の `src` を読みます。DB が複数あるときは `--schema billing=services/billing/**/*.sql` のように名前を付けます）、`--only <file|dep|db>`、`--port <n>`（デフォルト 4977、使用中なら +1）、`--host`、`--no-open`、`--clean`（この比較のレビューコメントと確認済みのマークを消してから開く）

サーバーはデフォルトで `127.0.0.1` だけで待ち受け、`localhost` / `127.0.0.1` 宛て以外のリクエストは拒否します。`--host 0.0.0.0` などを指定すると、同じネットワークの他の端末からリポジトリの構成とスキーマが見えるので注意してください。

## 画面

- **左のアイコンバー**: 「ファイル」「依存」「DB」を切り替えます。アイコンの数字は変更の件数、青い点は未対応のコメントがあることを示します。読むものがないモジュール（SQL ファイルがないリポジトリの DB など）は薄く表示します。表示中のモジュールは URL（`#file` / `#dep` / `#db`）に残るので、再読み込みしても同じ画面が開きます
- **ヘッダー**: 比較の対象、「AI 用にコピー」、「AI」（下の「AI レビューと修正」）、「再読み込み」。切り替えても、各モジュールで開いていた箱・選んだテーブル・書きかけのコメントはそのまま残ります
- **AI 用にコピー**: すべてのモジュールの未対応のコメントを、difit と同じ素朴な形でコピーします。モジュールごとの見出し（`## ファイルの差分` / `## 依存関係` / `## DB スキーマ`）の下に、1行目が指す先（ファイルは `path:L12`、依存は `元 → 先`、DB は `定義の場所 対象の名前`）、続けて本文を並べ、コメント同士は `=====` で区切ります。コミット同士の比較では先頭に `diff main..feature` が付きます。指示文は付けないので、どうするかは貼った先で伝えます
- **再読み込み**: AI がファイルを書き換えたあとに、すべてを解析し直します。開いていた状態はそのまま残ります
- **⌘F / Ctrl+F**: 表示中のモジュールの中を検索します。ファイルはファイル名と差分の行（折りたたんだファイルも）、依存はファイル名とフォルダ名（閉じたフォルダは開きます）、DB はテーブル名・カラム名・型（変更のないテーブルも。図がそこへ移動します）。Enter / Shift+Enter（⌘G / ⌘⇧G）で次・前、Aa で大文字と小文字を区別、Esc で閉じます。検索欄でもう一度 ⌘F を押すとブラウザの検索になります
- **DB が複数ある monorepo**: DB モジュールの中で DB を切り替えます（`atlas.hcl` ごと、または名前付きの `--schema` ごと）

## AI レビューと修正

作業ディレクトリとの比較（`diffshape` / `diffshape . main --merge-base` / `diffshape working`）では、ヘッダーの「AI」から、手元の Claude Code か Codex にレビューと修正をさせられます。diffshape はその PC に入っている `claude` / `codex` コマンドをそのまま起動するだけで、API キーやログインは扱いません（ターミナルで使えていれば動きます）。どちらも入っていないとき、コミット同士の比較のときは、ボタンを出しません。

| 実行 | すること |
|---|---|
| レビュー | 差分を読んでコメントを付けます。ファイルは変えません。コメントは自分で付けたものと同じ場所に「AI」の印つきで並び、編集も削除もできます |
| 修正 | 未対応のコメント（自分のものも AI のものも）に対応するよう、作業ディレクトリのファイルを編集します。終わると自動で読み直すので、コメントの「解消済み？」「コメント後に変更あり」で結果を確かめられます |
| レビューして修正 | レビューのあと、付いたコメントを続けて修正します |

- **エージェント・モデル・Effort** は、レビュー用と修正用を別々に選べます（Codex にレビューさせて Claude Code に直させる、など）。モデルと Effort の一覧は、入っている CLI から読みます。選ばなければ CLI の設定どおりです
- **範囲**: 表示中の画面だけか、すべての画面か。依存の画面では追加した import やファイルに、DB の画面ではテーブル・カラム・制約などにコメントが付きます
- **レビューは読むだけ**（`claude -p --permission-mode plan` / `codex exec --sandbox read-only`）、**修正は編集とコマンドの実行を許して**起動します（`--permission-mode auto` / `--sandbox workspace-write`）。確認なしで全部を通すオプションは使いません
- **プロンプトは最小限です**: diffshape が伝えるのは、読むだけにすること、答えの形、コメントがどこを指すかといった、画面にコメントを置くのに要ることだけです。修正には「AI 用にコピー」と同じ一覧を渡し、先頭に「各指摘に対応してください」と進め方を足します。コメントの書き方（言葉づかい、署名など）は、リポジトリの `AGENTS.md` / `CLAUDE.md` に書いてください。エージェントはそれに従います
- **修正の前の状態は残ります**: 修正を始める前の作業ディレクトリを `refs/diffshape/before-fix` に取っておきます（作業ディレクトリとステージ済みの状態は変えません）。`diffshape . refs/diffshape/before-fix` で AI が変えた分だけを見られ、`git restore --source=refs/diffshape/before-fix --worktree -- <path>` でファイルを戻せます
- **起動できるのはこの画面からだけ**です。別のサイトのページからのリクエストでは始まらず、`--host` でほかの端末に公開しているときは、AI の機能そのものを止めます
- `claude` / `codex` が PATH にないときは、環境変数 `DIFFSHAPE_CLAUDE` / `DIFFSHAPE_CODEX` に実行ファイルのパスを指定できます

それぞれの画面の見方は、[fileshape](https://github.com/kousaku-maron/diffshape/tree/main/packages/fileshape)、[depshape](https://github.com/kousaku-maron/diffshape/tree/main/packages/depshape)、[dbshape](https://github.com/kousaku-maron/diffshape/tree/main/packages/dbshape) の README を見てください。

## ライセンス

MIT（[LICENSE](LICENSE)）。次のものを同梱・利用しています。

- [React](https://react.dev/)（MIT）
- [dagre](https://github.com/dagrejs/dagre)（MIT）: ER 図の配置
- [libpg-query](https://github.com/constructive-io/libpg-query-node)（MIT）: SQL の解析
- [Feather](https://github.com/feathericons/feather)（MIT）: アイコンの線画
- [Prism](https://prismjs.com/)（MIT）: ファイルの差分のシンタックスハイライト
- [react-markdown](https://github.com/remarkjs/react-markdown) / [remark-gfm](https://github.com/remarkjs/remark-gfm)（MIT）: Markdown のプレビュー
