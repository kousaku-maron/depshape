import { beforeAll, describe, expect, it } from "vitest";
import { locations, parser } from "../src/analyze.js";
import { diffSchemas } from "../src/diff.js";
import { erTables } from "../src/er.js";
import type { DbShapeResult } from "../src/model.js";
import { buildSchema, type Parser } from "../src/schema.js";
import { changeText, commentState, formatPrompt, locationOf, newComment, type CommentTarget } from "../ui/src/comments.js";
import { parseTarget, reviewList, toComments } from "../ui/src/review.js";

let parse: Parser;
beforeAll(async () => {
  parse = await parser();
});

const BASE = `CREATE TABLE billing.invoices (
  id uuid PRIMARY KEY,
  total integer NOT NULL,
  memo text,
  status text NOT NULL,
  CONSTRAINT invoices_status_check CHECK (status IN ('draft', 'open'))
);
`;

const CHANGED = `CREATE TABLE billing.invoices (
  id uuid PRIMARY KEY,
  total bigint NOT NULL,
  status text NOT NULL,
  price_id uuid,
  CONSTRAINT invoices_status_check CHECK (status IN ('draft', 'open', 'closed'))
);
`;

function result(before: string, after: string): DbShapeResult {
  const b = buildSchema([{ path: "db/billing.sql", sql: before }], parse);
  const a = buildSchema([{ path: "db/billing.sql", sql: after }], parse);
  const diff = diffSchemas(b, a);
  return {
    database: { id: "atlas.hcl", name: "(ルート)" },
    repoRoot: "/repo",
    generatedAt: "",
    base: { label: "main", files: ["db/billing.sql"] },
    target: { label: "作業ツリー", files: ["db/billing.sql"] },
    schemaFrom: { kind: "atlas", configs: ["atlas.hcl"] },
    diff,
    er: erTables(b, a, diff),
    locations: locations(b, a),
    ignored: [],
    warnings: [],
  };
}

const T = "billing.invoices";
const col = (name: string): CommentTarget => ({ kind: "column", table: T, name });

describe("changeText", () => {
  it("describes the current change of each kind of target", () => {
    const d = result(BASE, CHANGED);
    expect(changeText(d, { kind: "table", table: T, name: T })).toBe("今回変更（カラム +1 −1 ~1、制約 ~1）");
    expect(changeText(d, col("total"))).toBe("今回変更: integer NOT NULL → bigint NOT NULL");
    expect(changeText(d, col("price_id"))).toBe("今回追加: uuid");
    expect(changeText(d, col("memo"))).toBe("今回削除: text");
    expect(changeText(d, col("id"))).toBeUndefined();
    expect(changeText(d, { kind: "value", table: T, name: "status" })).toBe("+closed（変更後: draft, open, closed）");
  });
});

describe("locationOf", () => {
  it("points at the definition, the CHECK for values, and the base side for removed parts", () => {
    const d = result(BASE, CHANGED);
    expect(locationOf(d, col("price_id"))).toEqual({ file: "db/billing.sql", line: 5 });
    expect(locationOf(d, { kind: "value", table: T, name: "status" })).toEqual({ file: "db/billing.sql", line: 6 });
    expect(locationOf(d, col("memo"))).toEqual({ file: "db/billing.sql", line: 4, base: true });
  });
});

describe("commentState", () => {
  it("is resolved when the change is gone, updated when it changed again", () => {
    const d = result(BASE, CHANGED);
    const onAmount = newComment(d, col("total"), "bigint にする理由は？");
    const onId = newComment(d, col("id"), "uuid v7 にしたい");
    const onNew = newComment(d, col("price_id"), "NOT NULL では？");
    expect([onAmount, onId, onNew].map((c) => commentState(d, c))).toEqual(["open", "open", "open"]);

    // the type change is reverted, price_id gets NOT NULL, price_id is later dropped
    const reverted = result(BASE, CHANGED.replace("total bigint", "total integer").replace("price_id uuid,", "price_id uuid NOT NULL,"));
    expect(commentState(reverted, onAmount)).toBe("resolved");
    expect(commentState(reverted, onId)).toBe("open");
    expect(commentState(reverted, onNew)).toBe("updated");
    expect(commentState(result(BASE, CHANGED.replace("  price_id uuid,\n", "")), onNew)).toBe("resolved");
  });
});

describe("formatPrompt", () => {
  it("lists open comments like difit: where the target is defined and its name, then the comment", () => {
    const d = result(BASE, CHANGED);
    const comments = [newComment(d, col("price_id"), "既存の行があるので\nNOT NULL にするなら段階的に"), newComment(d, col("total"), "bigint にする理由は？")];
    // the type change is reverted: that comment is left out
    const reverted = result(BASE, CHANGED.replace("total bigint", "total integer"));
    const { text, included, skipped } = formatPrompt(reverted, comments);
    expect(included).toBe(1);
    expect(skipped).toBe(1);
    expect(text).toBe("db/billing.sql:L5 カラム billing.invoices.price_id\n既存の行があるので\nNOT NULL にするなら段階的に\n");
    expect(formatPrompt(d, comments).text.split("\n=====\n")).toHaveLength(2);
  });

  it("marks a part only the base side has with (old), like a removed line", () => {
    // compared the other way round: price_id is removed
    const d = result(CHANGED, BASE);
    expect(formatPrompt(d, [newComment(d, col("price_id"), "消して大丈夫？")]).text).toBe("db/billing.sql:L5 (old) カラム billing.invoices.price_id\n消して大丈夫？\n");
  });
});

describe("AI review", () => {
  const item = (target: string | null, body = "NOT NULL では？") => ({ module: "db", body, target, path: null, side: null, line: null, endLine: null, code: null });

  it("tells the reviewer every changed part of a database, with the target a comment names", () => {
    const text = reviewList(result(BASE, CHANGED));
    expect(text.split("\n").slice(0, 3)).toEqual([
      "スキーマの SQL: atlas.hcl の src",
      "変更:",
      `- テーブル billing.invoices（今回変更（カラム +1 −1 ~1、制約 ~1）） 定義: db/billing.sql:1 target: "table:billing.invoices:billing.invoices"`,
    ]);
    expect(text).toContain(`  - カラム billing.invoices.price_id（今回追加: uuid） 定義: db/billing.sql:5 target: "column:billing.invoices:price_id"`);
    // a removed column has no place in the target side's files
    expect(text).toContain(`  - カラム billing.invoices.memo（今回削除: text） target: "column:billing.invoices:memo"`);
    expect(text).toContain(`- 値 billing.invoices.status（+closed（変更後: draft, open, closed）） 定義: db/billing.sql:6 target: "value:billing.invoices:status"`);
    // with several databases each target says which one
    expect(reviewList(result(BASE, CHANGED), "2/")).toContain(`target: "2/column:billing.invoices:price_id"`);
    expect(reviewList(result(BASE, BASE))).toBe("");
  });

  it("reads a target back", () => {
    expect(parseTarget("column:billing.invoices:price_id")).toEqual({ kind: "column", table: T, name: "price_id" });
    expect(parseTarget("type::billing.mood")).toEqual({ kind: "type", name: "billing.mood" });
    expect(parseTarget("billing.invoices.price_id")).toBeNull();
    expect(parseTarget("row:billing.invoices:1")).toBeNull();
  });

  it("keeps the comments that name a part of the schema, marked as the AI's, with the change they saw", () => {
    const d = result(BASE, CHANGED);
    const kept = toComments(
      [item("column:billing.invoices:price_id"), item("column:billing.invoices:id", "uuid v7 に"), item("column:billing.invoices:memo", "消してよい？"), item("column:billing.invoices:nope"), item("table:billing.none:billing.none"), item("price_id"), item(null)],
      d,
      "",
      "Claude Code",
    );
    expect(kept.map((c) => [c.target.name, c.body, c.ai, c.snapshot])).toEqual([
      ["price_id", "NOT NULL では？", "Claude Code", "今回追加: uuid"],
      ["id", "uuid v7 に", "Claude Code", undefined],
      ["memo", "消してよい？", "Claude Code", "今回削除: text"],
    ]);
    expect(commentState(d, kept[0])).toBe("open");
    // another database's comments are not this one's
    expect(toComments([item("1/column:billing.invoices:price_id"), item("2/column:billing.invoices:total")], d, "2/", "Codex").map((c) => c.target.name)).toEqual(["total"]);
  });
});
