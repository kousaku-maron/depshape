import { openBrowser, type Analyzer, type CompareOptions } from "@diffshape/core";
import { COLORS, dbAnalyzer, formatSummary, PLAIN, type DbShapeResult } from "@diffshape/dbshape";
import { depAnalyzer } from "@diffshape/depshape";
import { App } from "./app.js";
import { startServer } from "./server.js";

/*
 * The command line. `diffshape` shows every module; `depshape` and `dbshape` are the same app with one
 * module (and keep the --json / --text output of the old commands).
 */

export type ModuleId = "dep" | "db";

const TARGETS = `target:
  .            作業ディレクトリ（未コミットの変更すべて）  ※デフォルト
  staged       ステージ済みの変更
  working      未ステージの変更のみ（比較元はステージ済みの状態）
  <rev>        コミット / ブランチ（@ は HEAD）

compare-with:
  比較元のリビジョン。省略時は target が . / staged なら HEAD、<rev> なら <rev>^`;

const COMMON = `  --merge-base       compare-with と target の分岐点を比較元にする（GitHub の PR と同じ見え方）
  --port <n>         ポート番号（デフォルト 4977、使用中なら +1）
  --host <host>      待ち受けホスト（デフォルト 127.0.0.1。0.0.0.0 などにすると同じネットワークから
                     リポジトリの構成が見えるので注意）
  --no-open          ブラウザを自動で開かない`;

const SCHEMA = `  --schema <glob>    スキーマの SQL ファイル（複数指定可）。省略時は atlas.hcl の src を読む`;

const HELP: Record<"all" | ModuleId, string> = {
  all: `diffshape - git の差分を、コードの依存関係（depshape）と DB スキーマ（dbshape）の形で見せます

使い方:
  diffshape [target] [compare-with] [options]

${TARGETS}

options:
${COMMON}
${SCHEMA}
  --only <dep|db>    片方のモジュールだけを表示する（depshape / dbshape コマンドと同じ）
  -h, --help         このヘルプを表示

例:
  diffshape                       未コミットの変更 vs HEAD
  diffshape . main --merge-base   未コミットの変更を含む現在の状態 vs main からの分岐点
  diffshape @ abc1234             HEAD vs 特定のコミット
`,
  dep: `depshape - git の差分による依存関係の変化を、既存の構造と並べて可視化します（Go / TypeScript / JavaScript 対応）
（diffshape の依存モジュールだけを開きます）

使い方:
  depshape [target] [compare-with] [options]

${TARGETS}

options:
${COMMON}
  --json             サーバーを起動せず、解析結果の JSON を標準出力に出す
  -h, --help         このヘルプを表示
`,
  db: `dbshape - git の差分で PostgreSQL のスキーマ（テーブル・カラム・制約・外部キー・CHECK の値）がどう変わったかを見せます
（diffshape の DB モジュールだけを開きます）

使い方:
  dbshape [target] [compare-with] [options]

${TARGETS}

options:
${COMMON}
${SCHEMA}
  --text             サーバーを起動せず、差分の要約をターミナルに出す
  --json             サーバーを起動せず、差分を JSON で標準出力に出す
  --no-color         --text の出力に色を付けない
  -h, --help         このヘルプを表示
`,
};

interface Args extends CompareOptions {
  port: number;
  host: string;
  open: boolean;
  json: boolean;
  text: boolean;
  color: boolean;
  schema: string[];
  only?: ModuleId;
}

export function parseArgs(argv: string[], command: "diffshape" | "depshape" | "dbshape"): Args {
  const fixed: ModuleId | undefined = command === "depshape" ? "dep" : command === "dbshape" ? "db" : undefined;
  const fail = (msg: string): never => {
    throw new UsageError(msg);
  };
  const args: Args = { port: 4977, host: "127.0.0.1", open: true, json: false, text: false, color: !!process.stdout.isTTY && !process.env.NO_COLOR, schema: [], only: fixed };
  const positional: string[] = [];
  const allowed = (opt: string, ok: boolean) => ok || fail(`不明なオプション: ${opt}`);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-h":
      case "--help":
        process.stdout.write(HELP[fixed ?? "all"]);
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
      case "--schema":
        allowed(a, fixed !== "dep");
        args.schema.push(argv[++i] ?? fail("--schema には glob が必要です"));
        break;
      case "--only": {
        allowed(a, !fixed);
        const v = argv[++i];
        if (v !== "dep" && v !== "db") fail("--only には dep か db を指定してください");
        args.only = v as ModuleId;
        break;
      }
      case "--json":
        allowed(a, !!fixed);
        args.json = true;
        break;
      case "--text":
        allowed(a, fixed === "db");
        args.text = true;
        break;
      case "--no-color":
        allowed(a, fixed === "db");
        args.color = false;
        break;
      default:
        if (a.startsWith("-") && a !== "-") fail(`不明なオプション: ${a}`);
        positional.push(a);
    }
  }
  if (positional.length > 2) fail("引数が多すぎます（target と compare-with の2つまで）");
  [args.target, args.base] = positional;
  if (args.mergeBase && !args.base) fail(`--merge-base には compare-with の指定が必要です（例: ${command} . main --merge-base）`);
  return args;
}

export class UsageError extends Error {}

export async function run(command: "diffshape" | "depshape" | "dbshape", argv: string[]): Promise<void> {
  const fail = (msg: string): never => {
    process.stderr.write(`${command}: ${msg}\n`);
    process.exit(1);
  };
  let args: Args;
  try {
    args = parseArgs(argv, command);
  } catch (e) {
    return fail((e as Error).message);
  }

  const all: Analyzer[] = [depAnalyzer, dbAnalyzer({ schema: args.schema })];
  const analyzers = args.only ? all.filter((a) => a.id === args.only) : all;
  const app = new App(process.cwd(), args, analyzers);
  try {
    await app.refresh();
    // output without a server: one module only (checked by parseArgs)
    if (args.json || args.text) {
      const r = await app.result(analyzers[0].id);
      if ("error" in r) return fail(r.error);
      if (args.text) process.stdout.write(formatSummary(r.data as DbShapeResult, args.color ? COLORS : PLAIN));
      else process.stdout.write(JSON.stringify(r.data, null, 2) + "\n");
      return;
    }
    const { url } = await startServer(app, args.host, args.port);
    process.stdout.write(`${command}: ${url} で表示中（Ctrl+C で終了）\n`);
    if (args.open) openBrowser(url);
  } catch (e) {
    const msg = e instanceof Error ? (e as Error & { stderr?: string }).stderr || e.message : String(e);
    fail(msg.trim());
  }
}
