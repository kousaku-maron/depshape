#!/usr/bin/env node
import { openBrowser } from "@diffshape/core";
import { analyze, type AnalyzeOptions } from "./analyze.js";
import { COLORS, PLAIN, formatSummary } from "./format.js";
import { startServer } from "./server.js";

const HELP = `dbshape - git の差分で PostgreSQL のスキーマ（テーブル・カラム・制約・外部キー・CHECK の値）がどう変わったかを見せます

使い方:
  dbshape [target] [compare-with] [options]

target:
  .            作業ディレクトリ（未コミットの変更すべて）  ※デフォルト
  staged       ステージ済みの変更
  working      未ステージの変更のみ（比較元はステージ済みの状態）
  <rev>        コミット / ブランチ（@ は HEAD）

compare-with:
  比較元のリビジョン。省略時は target が . / staged なら HEAD、<rev> なら <rev>^

options:
  --merge-base       compare-with と target の分岐点を比較元にする（GitHub の PR と同じ見え方）
  --schema <glob>    スキーマの SQL ファイル（複数指定可）。省略時は atlas.hcl の src を読む
  --port <n>         ポート番号（デフォルト 4987、使用中なら +1）
  --host <host>      待ち受けホスト（デフォルト 127.0.0.1。0.0.0.0 などにすると同じネットワークから
                     スキーマが見えるので注意）
  --no-open          ブラウザを自動で開かない
  --text             サーバーを起動せず、差分の要約をターミナルに出す
  --json             サーバーを起動せず、差分を JSON で標準出力に出す
  --no-color         --text の出力に色を付けない
  -h, --help         このヘルプを表示

例:
  dbshape . main --merge-base
  dbshape . main --merge-base --schema 'db/schema/**/*.sql'
`;

interface Args extends AnalyzeOptions {
  port: number;
  host: string;
  open: boolean;
  text: boolean;
  json: boolean;
  color: boolean;
}

function fail(msg: string): never {
  process.stderr.write(`dbshape: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { port: 4987, host: "127.0.0.1", open: true, text: false, json: false, color: !!process.stdout.isTTY && !process.env.NO_COLOR, schema: [] };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-h":
      case "--help":
        process.stdout.write(HELP);
        process.exit(0);
      case "--merge-base":
        args.mergeBase = true;
        break;
      case "--schema":
        args.schema!.push(argv[++i] ?? fail("--schema には glob が必要です"));
        break;
      case "--port":
        args.port = Number(argv[++i]);
        if (!Number.isInteger(args.port)) fail("--port には数値を指定してください");
        break;
      case "--host":
        args.host = argv[++i] ?? fail("--host には値が必要です");
        break;
      case "--no-open":
        args.open = false;
        break;
      case "--text":
        args.text = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "--no-color":
        args.color = false;
        break;
      default:
        if (a.startsWith("-") && a !== "-") fail(`不明なオプション: ${a}`);
        positional.push(a);
    }
  }
  if (positional.length > 2) fail("引数が多すぎます（target と compare-with の2つまで）");
  [args.target, args.base] = positional;
  if (args.mergeBase && !args.base) fail("--merge-base には compare-with の指定が必要です（例: dbshape . main --merge-base）");
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  if (args.json || args.text) {
    const result = await analyze(cwd, args);
    if (args.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    else process.stdout.write(formatSummary(result, args.color ? COLORS : PLAIN));
    return;
  }
  const { url } = await startServer(cwd, args, args.host, args.port);
  process.stdout.write(`dbshape: ${url} で表示中（Ctrl+C で終了）\n`);
  if (args.open) openBrowser(url);
}

main().catch((e) => {
  const msg = e instanceof Error ? (e as Error & { stderr?: string }).stderr || e.message : String(e);
  fail(msg.trim());
});
