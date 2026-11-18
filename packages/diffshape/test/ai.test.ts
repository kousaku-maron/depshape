import { describe, expect, it } from "vitest";
import { commentsPrompt, effortsOf, elapsed, fixPrompt, pick, plainReport, readPrefs, reviewOutcome, reviewPrompt, settle, type AgentInfo, type Compared, type Section } from "../ui/src/ai";

const claude: AgentInfo = {
  id: "claude",
  label: "Claude Code",
  models: [
    { id: "sonnet", label: "Sonnet", efforts: ["low", "high", "max"] },
    { id: "haiku", label: "Haiku", efforts: [] },
  ],
  defaultEfforts: ["low", "high", "max"],
};
const codex: AgentInfo = { id: "codex", label: "Codex", models: [{ id: "gpt-x", label: "GPT-X", efforts: ["low", "ultra"] }], defaultEfforts: ["low", "ultra"] };

describe("what the user chose", () => {
  it("reads saved choices, whatever the storage holds", () => {
    expect(readPrefs(null)).toEqual({ review: { agent: "", by: {} }, fix: { agent: "", by: {} }, scope: "current" });
    expect(readPrefs({ review: { agent: "codex", by: { codex: { model: "gpt-x", effort: 3 } } }, fix: "x", scope: "all" })).toEqual({
      review: { agent: "codex", by: { codex: { model: "gpt-x", effort: "" } } },
      fix: { agent: "", by: {} },
      scope: "all",
    });
  });

  it("settles on what can run: an agent that is there, a model of its list, an effort the model takes", () => {
    expect(settle({ agent: "", by: {} }, [])).toBeNull();
    // nothing chosen yet: the first agent with its own defaults
    expect(settle({ agent: "", by: {} }, [claude, codex])).toEqual({ agent: claude, model: "", effort: "" });
    expect(settle({ agent: "codex", by: { codex: { model: "gpt-x", effort: "ultra" } } }, [claude, codex])).toEqual({ agent: codex, model: "gpt-x", effort: "ultra" });
    // the agent is gone, a model left the list, an effort the model does not take
    expect(settle({ agent: "codex", by: { claude: { model: "sonnet", effort: "max" } } }, [claude])).toEqual({ agent: claude, model: "sonnet", effort: "max" });
    expect(settle({ agent: "claude", by: { claude: { model: "opus-9", effort: "high" } } }, [claude])).toEqual({ agent: claude, model: "", effort: "high" });
    expect(settle({ agent: "claude", by: { claude: { model: "haiku", effort: "high" } } }, [claude])).toEqual({ agent: claude, model: "haiku", effort: "" });
    expect(effortsOf(claude, "haiku")).toEqual([]);
    expect(effortsOf(claude, "")).toEqual(["low", "high", "max"]);
  });

  it("keeps each agent's model and effort when the agent is switched", () => {
    let c = pick({ agent: "", by: {} }, "claude", { model: "sonnet" });
    c = pick(c, "claude", { effort: "max" });
    c = pick(c, "codex", {});
    expect(c).toEqual({ agent: "codex", by: { claude: { model: "sonnet", effort: "max" }, codex: { model: "", effort: "" } } });
    expect(settle(pick(c, "claude", {}), [claude, codex])).toMatchObject({ model: "sonnet", effort: "max" });
  });
});

describe("prompts", () => {
  const compared: Compared = { repoRoot: "/work/acme", targetLabel: "作業ディレクトリ（未コミットの変更を含む）", baseLabel: "HEAD", baseRev: "abc1234" };
  const sections: Section[] = [
    { id: "file", description: "ファイルの差分（fileshape）", review: "変更されたファイル（1）:\n- M src/a.ts", comments: "1. src/a.ts:L3\n   コメント: 境界を確かめる\n" },
    { id: "db", description: "DB スキーマ（dbshape）", review: "テーブル billing.invoices", comments: "" },
  ];

  it("copies the open comments of every module that has some", () => {
    const text = commentsPrompt(compared, sections);
    expect(text).toContain("リポジトリ: /work/acme");
    expect(text).toContain("## ファイルの差分（fileshape）\n\n1. src/a.ts:L3");
    expect(text).not.toContain("dbshape");
    expect(text.endsWith("境界を確かめる\n")).toBe(true);
  });

  it("asks a fixing agent to edit the working tree and nothing more", () => {
    const text = fixPrompt(compared, sections);
    expect(text.startsWith(commentsPrompt(compared, sections).trimEnd())).toBe(true);
    expect(text).toContain("コミットやステージ（git add）はしないでください");
  });

  it("asks a reviewer for comments each module can place, without repeating the ones that are there", () => {
    const text = reviewPrompt(compared, sections);
    expect(text).toContain("差分の見方: `git diff abc1234`");
    expect(text).toContain("読むだけにしてください");
    expect(text).toContain('## ファイルの差分（fileshape）（module: "file"）\n\n変更されたファイル（1）:\n- M src/a.ts\n\n既に付いているコメント:\n\n1. src/a.ts:L3');
    expect(text).toContain('## DB スキーマ（dbshape）（module: "db"）\n\nテーブル billing.invoices\n');
    // the staged state has no revision to name
    expect(reviewPrompt({ ...compared, baseRev: null }, sections)).toContain("差分の見方: `git diff`（ステージ済みの状態と作業ディレクトリの差分）");
  });
});

describe("what is shown of a job", () => {
  it("writes the time a job has run, and what a review came to", () => {
    expect(elapsed(7400)).toBe("0:07");
    expect(elapsed(754000)).toBe("12:34");
    expect(elapsed(-5)).toBe("0:00");
    expect(plainReport("- [src/a.ts](src/a.ts#L3) を直しました。`x[0](1)` はそのまま")).toBe("- src/a.ts を直しました。`x[0](1)` はそのまま");
    expect(reviewOutcome(0, 0)).toBe("指摘はありませんでした");
    expect(reviewOutcome(3, 0)).toBe("コメントを 3 件追加しました");
    expect(reviewOutcome(2, 1)).toBe("コメントを 2 件追加しました（1 件は指している場所が見つからず、追加していません）");
    expect(reviewOutcome(0, 2)).toBe("コメントは追加していません（2 件は指している場所が見つからず、追加していません）");
  });
});
