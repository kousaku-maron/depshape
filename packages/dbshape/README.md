# dbshape

git の差分で **PostgreSQL のスキーマがどう変わったか** を見せるツールです（開発中）。
push 前のローカルレビューで、次の3つをすばやく確かめるために使います。

- 新しいテーブルは何か
- 既存のテーブルで何が変わったか（カラム・制約・外部キー・インデックス。削除も含む）
- enum のように使っているカラムで、値が増えた・減ったものはあるか

リポジトリの中の SQL ファイルだけを git から読みます。DB への接続、Docker、外部サービスは使いません。依存関係という事実だけを見せ、危険かどうかの判断はレビューする人が行います。

> 今は差分のモデルとターミナルへの要約、`--json` まで作っています。ER 図の差分を表示するブラウザの画面は次の段階で作ります。npm にはまだ公開していません。

## 使い方

解析したいリポジトリの中で実行します（Node.js 20 以上と git が必要です）。

```bash
dbshape . main --merge-base
```

比較の指定は [depshape](../depshape) と同じです。

| コマンド | 比較内容 |
|---|---|
| `dbshape` | 未コミットの変更すべて vs HEAD |
| `dbshape . main --merge-base` | 現在の作業ディレクトリ vs main からの分岐点（GitHub の PR と同じ見え方） |
| `dbshape abc1234` | そのコミット単体の変更 |
| `dbshape staged` / `dbshape working` | ステージ済み / 未ステージの変更のみ |

オプション: `--schema <glob>`（スキーマの SQL ファイル。複数指定可）、`--json`（差分を JSON で標準出力へ）、`--no-color`

## どのファイルを読むか

- 既定では、リポジトリの中の `atlas.hcl` の `src` に書かれた `file://` のパスを読みます（Atlas の宣言型の管理）。Atlas は実行せず、設定ファイルを文字列として読むだけです。フォルダが指定されていれば、その直下の `.sql` を名前順に読みます。
- Atlas を使っていなければ、`--schema 'db/schema/**/*.sql'` のように指定します。
- 比較元と変更後のそれぞれで探すので、PR で追加・削除されたスキーマファイルも比較に入ります。

## 何を比べるか

SQL は PostgreSQL 本体と同じ構文解析器（[libpg-query](https://github.com/constructive-io/libpg-query-node) の WebAssembly 版）で読み、文を順に適用してスキーマを組み立てます。`CREATE TABLE` の中に制約を書く形も、pg_dump のように `ALTER TABLE ONLY ... ADD CONSTRAINT` で後から足す形も、同じスキーマになります。比較は構文木で行うので、改行や空白、`integer` と `int4` のような書き方の違いは変更になりません。

| 対象 | 内容 |
|---|---|
| テーブル | 追加・削除。追加・削除されたテーブルは、カラム・制約・インデックスをすべて表示 |
| カラム | 追加・削除・型・NOT NULL・デフォルト・IDENTITY・生成列・コメントの変更 |
| 制約 | 主キー・ユニーク・外部キー（参照先と ON DELETE / ON UPDATE）・CHECK の追加・削除・変更。名前のない制約は PostgreSQL と同じ規則で名前を付けて比べます（`invoices_pkey`、`invoices_price_id_fkey` など） |
| インデックス | 追加・削除・対象カラムや式、UNIQUE、WHERE などの変更 |
| 値の変化 | 既存のカラムで、値として許されるものの増減。読み取るのは SQL に書かれたものだけです |
| 型 | ENUM 型・DOMAIN の追加・削除・変更 |

### 値の変化として読むもの

- CHECK の値リスト: `col IN ('a', 'b')`、`col = ANY (ARRAY['a', 'b'])`（pg_dump の書き方。`::text` などのキャストがあっても可）、`col = 'a' OR col = 'b'`（`col IS NULL OR ...` も可）
- ENUM 型の値（その型を使っているカラムも表示）
- DOMAIN の CHECK の値リスト

アプリのコードの定数（Go や TypeScript の型など）は読みません。値の増減を見落としたくない文字列のカラムには、CHECK を付けておくとここに出ます。値を読み取れない CHECK（範囲や正規表現など）は、制約の変更として式の変更前 → 変更後を表示します。

### 比較しないもの

関数・ビュー・トリガー・権限（GRANT）・拡張などの文は読み飛ばし、件数だけを表示します。構文エラーで読めなかったファイルがあると、そのファイルのテーブルは比較から外して注意を表示します（ファイル全体が削除されたように見えないようにするためです）。

## 開発

[diffshape](https://github.com/kousaku-maron/diffshape) リポジトリの `packages/dbshape` にあります。リポジトリのルートで `pnpm install` したあと、このフォルダで実行します。

```bash
pnpm test        # スキーマの組み立て・CHECK の値・差分・ファイルの探し方のテスト
pnpm typecheck
pnpm build       # dist/cli.js にビルド
node /path/to/packages/dbshape/dist/cli.js . main --merge-base   # 解析したいリポジトリの中で
```

## ライセンス

MIT（[LICENSE](LICENSE)）
