# diffshape

git の差分の「形」を、push 前のローカルレビューで確かめるためのツール群です。どれも事実だけを見せ、判断はレビューする人に任せます。

| パッケージ | 内容 |
|---|---|
| [depshape](packages/depshape) | 差分でフォルダ・ファイル間の依存関係がどう変わったかを、既存の構造と並べて可視化します（Go / TypeScript / JavaScript） |
| dbshape | 差分でデータベースのスキーマ（テーブル・カラム・制約・外部キー・CHECK の値）がどう変わったかを見せます（開発中） |

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

パッケージごとの作業は `pnpm --filter @kousaku-maron/depshape <script>` か、そのフォルダの中で実行します。npm への公開もパッケージのフォルダから行います。

## ライセンス

MIT（[LICENSE](LICENSE)）
