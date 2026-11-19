/*
 * The AI review and fix, without the screen: what the server says can run (the shapes of
 * packages/diffshape/src/agent.ts), what the user chose, and the prompts.
 */

export interface AgentModel {
  id: string;
  label: string;
  description?: string;
  efforts: string[];
}

export interface AgentInfo {
  id: string;
  label: string;
  version?: string;
  models: AgentModel[];
  /** The efforts to offer while no model is chosen */
  defaultEfforts: string[];
}

export type JobKind = "review" | "fix";

export interface AgentJob {
  id: number;
  kind: JobKind;
  agent: string;
  model?: string;
  effort?: string;
  status: "running" | "done" | "failed" | "cancelled";
  startedAt: number;
  endedAt?: number;
  log: string[];
  error?: string;
  text?: string;
  comments?: unknown[];
  snapshot?: string;
  changedFiles?: string[];
}

export interface AgentState {
  available: boolean;
  reason?: string;
  agents: AgentInfo[];
  job: AgentJob | null;
}

/** The comparison, as `/api/info` gives it */
export interface Compared {
  repoRoot: string;
  targetLabel: string;
  baseLabel: string;
  baseRev: string | null;
  /** "diff main..feature (…)" when both sides are commits: the first line of a copied list */
  range: string | null;
}

// ---- what the user chose: an agent for each of the two jobs, and a model and an effort for each agent

/** "" is the agent's own default (its settings) */
export interface Picked {
  model: string;
  effort: string;
}

export interface Choice {
  agent: string;
  /** The model and effort last picked for each agent, kept when the agent is switched */
  by: Record<string, Picked>;
}

export type Scope = "current" | "all";

export interface AiPrefs {
  review: Choice;
  fix: Choice;
  scope: Scope;
}

export const NO_PREFS: AiPrefs = { review: { agent: "", by: {} }, fix: { agent: "", by: {} }, scope: "current" };

const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const text = (v: unknown) => (typeof v === "string" ? v : "");

/** Saved choices read back: anything can be in the browser's storage */
export function readPrefs(v: unknown): AiPrefs {
  const choice = (c: unknown): Choice => ({
    agent: text(record(c).agent),
    by: Object.fromEntries(Object.entries(record(record(c).by)).map(([id, p]) => [id, { model: text(record(p).model), effort: text(record(p).effort) }])),
  });
  const r = record(v);
  return { review: choice(r.review), fix: choice(r.fix), scope: r.scope === "all" ? "all" : "current" };
}

/** The efforts to offer: the chosen model's, or the agent's own while no model is chosen */
export const effortsOf = (agent: AgentInfo, model: string): string[] => agent.models.find((m) => m.id === model)?.efforts ?? agent.defaultEfforts;

/**
 * A choice that can run: an agent that is there (the first one otherwise), a model of its list and an
 * effort that model takes. What is no longer offered falls back to the default.
 */
export function settle(choice: Choice, agents: AgentInfo[]): { agent: AgentInfo; model: string; effort: string } | null {
  const agent = agents.find((a) => a.id === choice.agent) ?? agents[0];
  if (!agent) return null;
  const picked = choice.by[agent.id] ?? { model: "", effort: "" };
  const model = agent.models.some((m) => m.id === picked.model) ? picked.model : "";
  const effort = effortsOf(agent, model).includes(picked.effort) ? picked.effort : "";
  return { agent, model, effort };
}

export const pick = (choice: Choice, agent: string, change: Partial<Picked>): Choice => ({
  agent,
  by: { ...choice.by, [agent]: { ...(choice.by[agent] ?? { model: "", effort: "" }), ...change } },
});

// ---- prompts

/** One module's part of a prompt */
export interface Section {
  /** The module's id: what a review comment for it has as `module` */
  id: string;
  /** Its heading ("ファイルの差分") */
  heading: string;
  /** What the reviewer is told about the module (CommentReport.review) */
  review?: string;
  /** The module's open comments as a list (CommentReport.prompt), or "" */
  comments: string;
}

/**
 * The open comments of every module, as "AI 用にコピー" copies them: like difit's list (where, then
 * the body, "=====" between comments) under a heading for each module, after the range of a comparison
 * of commits. No instruction: what to do with them is the reader's (or its repository's) business.
 */
export function commentsPrompt(c: Compared, sections: Section[]): string {
  const parts = sections.filter((s) => s.comments.trim()).map((s) => `## ${s.heading}\n\n${s.comments.trimEnd()}`);
  return [...(c.range ? [c.range] : []), ...parts].join("\n\n") + "\n";
}

/** The comments, for an agent that edits the working tree itself: what to do, then the copied list as it is */
export function fixPrompt(c: Compared, sections: Section[]): string {
  return [
    "各指摘に対応してください。",
    "",
    "- 作業ディレクトリのファイルを直接編集してください。",
    "- コミットやステージ（git add）はしないでください。",
    "- 指摘と関係のない変更はしないでください。",
    "- 最後に、何を変えたかを短く報告してください。対応しなかった指摘があれば、その理由も書いてください。",
    "",
    commentsPrompt(c, sections),
  ].join("\n");
}

/** How the reviewer sees the diff itself: the command for this comparison */
function diffCommand(c: Compared): string {
  if (c.baseRev === null) return "`git diff`（ステージ済みの状態と作業ディレクトリの差分）";
  return `\`git diff ${c.baseRev}\`（まだ git に追加していない新しいファイルはこの差分に出ません。下の一覧にあるものは直接読んでください）`;
}

/**
 * Asks for a review of the modules in `sections`, answered as comments each module can place. It says
 * only what diffshape needs (read only, the answer's shape, what a comment points at); how to write the
 * comments is left to the repository's own instructions.
 */
export function reviewPrompt(c: Compared, sections: Section[]): string {
  const out = [
    "あなたはコードレビュアーです。git の差分のレビュービューア diffshape から呼ばれています。次の変更をレビューして、指摘をコメントとして返してください。",
    `比較: ${c.targetLabel} と ${c.baseLabel} の差分`,
    `差分の見方: ${diffCommand(c)}`,
    "",
    "## 決まり",
    "",
    "- 読むだけにしてください。ファイルの変更、コミット、ステージはしないでください。",
    "- 直す価値のある指摘だけを書いてください（バグ、考慮漏れ、既存の作りとの食い違い、危険な変更など）。好みの問題や細かい書き方の指摘は要りません。問題がなければ comments は空の配列にしてください。",
    "- 1つの指摘を1つのコメントにしてください。",
    "- 「既に付いているコメント」と同じ指摘は書かないでください。",
    "- 各コメントの module には、下の見出しにある module の値を入れてください。コメントの付け方は見出しごとに違います。使わない項目は null にしてください。",
    "",
  ];
  for (const s of sections) {
    out.push(`## ${s.heading}（module: "${s.id}"）`, "", (s.review ?? "").trimEnd(), "");
    if (s.comments.trim()) out.push("既に付いているコメント:", "", s.comments.trimEnd(), "");
  }
  return out.join("\n").trimEnd() + "\n";
}

/** "0:07", "12:34" */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** What a finished review did, in one line */
export function reviewOutcome(placed: number, dropped: number): string {
  if (placed === 0 && dropped === 0) return "指摘はありませんでした";
  const lost = dropped ? `（${dropped} 件は指している場所が見つからず、追加していません）` : "";
  return placed ? `コメントを ${placed} 件追加しました${lost}` : `コメントは追加していません${lost}`;
}

/** An agent's report as plain text: a Markdown link ("[src/a.ts](src/a.ts#L3)") is shown as its text; code in backticks stays as it is */
export const plainReport = (text: string): string =>
  text
    .split(/(`[^`\n]*`)/)
    .map((part, i) => (i % 2 ? part : part.replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, "$1")))
    .join("");
