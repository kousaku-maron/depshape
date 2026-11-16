# diffshape

git の差分の「形」を、push 前のローカルレビューで確かめるためのツール群です。どれも事実だけを見せ、判断はレビューする人に任せます。

| パッケージ | 内容 |
|---|---|
| [depshape](packages/depshape) | 差分でフォルダ・ファイル間の依存関係がどう変わったかを、既存の構造と並べて可視化します（Go / TypeScript / JavaScript） |
| [dbshape](packages/dbshape) | 差分で PostgreSQL のスキーマ（テーブル・カラム・制約・外部キー・CHECK の値）がどう変わったかを、ER 図の差分で見せます（開発中・未公開） |

それぞれ npm の別パッケージとして公開しています。

```bash
npx @kousaku-maron/depshape . main --merge-base
```

## 開発

pnpm のワークスペースで管理しています（Node.js 20 以上）。

```bash
pnpm install
pnpm test        # 全パッケージのテスト
pnpm typecheck
pnpm build
```

共通の部分は、Node 側（git の読み取り、比較対象の解決、ローカルサーバー）が `packages/core`、画面側（色・基本スタイル・アイコン・小さな関数）が `packages/ui` にあり、各ツールのビルド時に取り込みます（どちらも npm には公開しません）。

パッケージごとの作業は `pnpm --filter @kousaku-maron/depshape <script>` か、そのフォルダの中で実行します。npm への公開は、パッケージのフォルダで `pnpm publish` を使います（`workspace:*` の依存を書き換えて公開するため。`npm publish` は使いません）。

## ライセンス

MIT（[LICENSE](LICENSE)）
