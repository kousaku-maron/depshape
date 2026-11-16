import { beforeAll, describe, expect, it } from "vitest";
import { locations, parser } from "../src/analyze.js";
import { diffSchemas } from "../src/diff.js";
import { erTables } from "../src/er.js";
import type { DbShapeResult } from "../src/model.js";
import { buildSchema, type Parser } from "../src/schema.js";
import { changeText, commentState, formatPrompt, locationOf, newComment, type CommentTarget } from "../ui/src/comments.js";

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
  it("lists open comments with the change, where it is defined and the comment", () => {
    const d = result(BASE, CHANGED);
    const comments = [newComment(d, col("price_id"), "既存の行があるので\nNOT NULL にするなら段階的に"), newComment(d, col("total"), "bigint にする理由は？")];
    // the type change is reverted: that comment is left out
    const reverted = result(BASE, CHANGED.replace("total bigint", "total integer"));
    const { text, included, skipped } = formatPrompt(reverted, comments);
    expect(included).toBe(1);
    expect(skipped).toBe(1);
    expect(text).toBe(
      [
        "以下は、git の差分のレビュービューア diffshape で付けたレビューコメントです。各指摘に対応してください。",
        "リポジトリ: /repo",
        "比較: 作業ツリー と main の差分",
        "対象: DB スキーマ（dbshape）",
        "スキーマの SQL: atlas.hcl の src",
        "",
        "1. カラム billing.invoices.price_id（今回追加: uuid）",
        "   定義: db/billing.sql:5",
        "   コメント: 既存の行があるので",
        "   NOT NULL にするなら段階的に",
        "",
      ].join("\n"),
    );
    // as a section of the prompt the app combines from every module
    expect(formatPrompt(reverted, comments, { header: false }).text.split("\n").slice(0, 3)).toEqual(["スキーマの SQL: atlas.hcl の src", "", "1. カラム billing.invoices.price_id（今回追加: uuid）"]);
  });
});
