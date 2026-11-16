#!/usr/bin/env node
import { analyze, type AnalyzeOptions } from "./analyze.js";
import { COLORS, PLAIN, formatSummary } from "./format.js";

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
  --json             差分を JSON で標準出力に出す
  --no-color         色を付けない
  -h, --help         このヘルプを表示

例:
  dbshape . main --merge-base
  dbshape . main --merge-base --schema 'db/schema/**/*.sql'
`;

interface Args extends AnalyzeOptions {
  json: boolean;
  color: boolean;
}

function fail(msg: string): never {
  process.stderr.write(`dbshape: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { json: false, color: !!process.stdout.isTTY && !process.env.NO_COLOR, schema: [] };
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
  const result = await analyze(process.cwd(), args);
  if (args.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  else process.stdout.write(formatSummary(result, args.color ? COLORS : PLAIN));
}

main().catch((e) => {
  const msg = e instanceof Error ? (e as Error & { stderr?: string }).stderr || e.message : String(e);
  fail(msg.trim());
});
