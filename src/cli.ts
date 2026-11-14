#!/usr/bin/env node
import { spawn } from "node:child_process";
import { analyze, type CompareOptions } from "./analyze.js";
import { startServer } from "./server.js";

const HELP = `depshape - git の差分による依存関係の変化を、既存の構造と並べて可視化します（Go 対応）

使い方:
  depshape [target] [compare-with] [options]

target:
  .            作業ディレクトリ（未コミットの変更すべて）  ※デフォルト
  staged       ステージ済みの変更
  working      未ステージの変更のみ（比較元はステージ済みの状態）
  <rev>        コミット / ブランチ（@ は HEAD）

compare-with:
  比較元のリビジョン。省略時は target が . / staged なら HEAD、<rev> なら <rev>^

options:
  --merge-base     compare-with と target の分岐点を比較元にする（GitHub の PR と同じ見え方）
  --port <n>       ポート番号（デフォルト 4977、使用中なら +1）
  --host <host>    待ち受けホスト（デフォルト 127.0.0.1。0.0.0.0 などにすると同じネットワークから
                   リポジトリの構成が見えるので注意）
  --no-open        ブラウザを自動で開かない
  --json           サーバーを起動せず、解析結果の JSON を標準出力に出す
  -h, --help       このヘルプを表示

例:
  depshape                       未コミットの変更 vs HEAD
  depshape . main --merge-base   未コミットの変更を含む現在の状態 vs main からの分岐点
  depshape @ abc1234             HEAD vs 特定のコミット
`;

interface Args extends CompareOptions {
  port: number;
  host: string;
  open: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { port: 4977, host: "127.0.0.1", open: true, json: false };
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
      case "--json":
        args.json = true;
        break;
      default:
        if (a.startsWith("-") && a !== "-") fail(`不明なオプション: ${a}`);
        positional.push(a);
    }
  }
  if (positional.length > 2) fail("引数が多すぎます（target と compare-with の2つまで）");
  [args.target, args.base] = positional;
  if (args.mergeBase && !args.base) fail("--merge-base には compare-with の指定が必要です（例: depshape . main --merge-base）");
  return args;
}

function fail(msg: string): never {
  process.stderr.write(`depshape: ${msg}\n`);
  process.exit(1);
}

function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const cmdArgs = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(cmd, cmdArgs, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();

  if (args.json) {
    process.stdout.write(JSON.stringify(await analyze(cwd, args), null, 2) + "\n");
    return;
  }

  const { url } = await startServer(cwd, args, args.host, args.port);
  process.stdout.write(`depshape: ${url} で表示中（Ctrl+C で終了）\n`);
  if (args.open) openBrowser(url);
}

main().catch((e) => {
  const msg = e instanceof Error ? (e as Error & { stderr?: string }).stderr || e.message : String(e);
  fail(msg.trim());
});
