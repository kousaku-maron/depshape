# diffshape

git の差分の「形」を、push 前のローカルレビューで確かめるためのアプリです。差分を3つの見方で、ブラウザに並べて見せます。

- **ファイル**（[fileshape](https://github.com/kousaku-maron/diffshape/tree/main/packages/fileshape)）: 変更された各ファイルの行の差分を、GitHub の Files changed と同じ形で見せます
- **依存**（[depshape](https://github.com/kousaku-maron/diffshape/tree/main/packages/depshape)）: フォルダ・ファイル間の依存関係がどう変わったかを、既存の構造と並べて見せます（Go / TypeScript / JavaScript）
- **DB**（[dbshape](https://github.com/kousaku-maron/diffshape/tree/main/packages/dbshape)）: PostgreSQL のスキーマ（テーブル・カラム・制約・外部キー・CHECK の値）がどう変わったかを、ER 図の差分で見せます

どれも git から直接ファイルを読みます。ビルドツールのインストール、DB への接続、外部サービスは要りません。事実だけを見せ、判断はレビューする人が行います。

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

オプション: `--merge-base`、`--schema <glob>`（スキーマの SQL ファイル。省略時はリポジトリ内のすべての `atlas.hcl` の `src` を読みます。DB が複数あるときは `--schema billing=services/billing/**/*.sql` のように名前を付けます）、`--only <file|dep|db>`、`--port <n>`（デフォルト 4977、使用中なら +1）、`--host`、`--no-open`

サーバーはデフォルトで `127.0.0.1` だけで待ち受け、`localhost` / `127.0.0.1` 宛て以外のリクエストは拒否します。`--host 0.0.0.0` などを指定すると、同じネットワークの他の端末からリポジトリの構成とスキーマが見えるので注意してください。

## 画面

- **左のアイコンバー**: 「ファイル」「依存」「DB」を切り替えます。アイコンの数字は変更の件数、青い点は未対応のコメントがあることを示します。読むものがないモジュール（SQL ファイルがないリポジトリの DB など）は薄く表示します。表示中のモジュールは URL（`#file` / `#dep` / `#db`）に残るので、再読み込みしても同じ画面が開きます
- **ヘッダー**: 比較の対象、「AI 用にコピー」、「再読み込み」。切り替えても、各モジュールで開いていた箱・選んだテーブル・書きかけのコメントはそのまま残ります
- **AI 用にコピー**: すべてのモジュールの未対応のコメントを、1つのプロンプトにまとめてコピーします（ファイルは `path:L12` とその行のコード、依存は import の状態と既存の依存のパターン、DB は SQL ファイルの定義位置つき）。Claude Code / Codex などにそのまま貼れます
- **再読み込み**: AI がファイルを書き換えたあとに、すべてを解析し直します。開いていた状態はそのまま残ります
- **DB が複数ある monorepo**: DB モジュールの中で DB を切り替えます（`atlas.hcl` ごと、または名前付きの `--schema` ごと）

それぞれの画面の見方は、[fileshape](https://github.com/kousaku-maron/diffshape/tree/main/packages/fileshape)、[depshape](https://github.com/kousaku-maron/diffshape/tree/main/packages/depshape)、[dbshape](https://github.com/kousaku-maron/diffshape/tree/main/packages/dbshape) の README を見てください。

## ライセンス

MIT（[LICENSE](LICENSE)）。次のものを同梱・利用しています。

- [React](https://react.dev/)（MIT）
- [dagre](https://github.com/dagrejs/dagre)（MIT）: ER 図の配置
- [libpg-query](https://github.com/constructive-io/libpg-query-node)（MIT）: SQL の解析
- [Feather](https://github.com/feathericons/feather)（MIT）: アイコンの線画
- [Prism](https://prismjs.com/)（MIT）: ファイルの差分のシンタックスハイライト
- [react-markdown](https://github.com/remarkjs/react-markdown) / [remark-gfm](https://github.com/remarkjs/remark-gfm)（MIT）: Markdown のプレビュー
