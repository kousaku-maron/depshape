import { beforeAll, describe, expect, it } from "vitest";
import { parser } from "../src/analyze.js";
import { checkValues } from "../src/checks.js";

let parse: (sql: string) => unknown;
beforeAll(async () => {
  parse = await parser();
});

/** The CHECK expression of `ALTER TABLE t ADD CHECK (<expr>)` */
function expr(sql: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tree = parse(`ALTER TABLE t ADD CHECK (${sql});`) as any;
  return tree.stmts[0].stmt.AlterTableStmt.cmds[0].AlterTableCmd.def.Constraint.raw_expr;
}

describe("checkValues", () => {
  it("reads IN lists", () => {
    expect(checkValues(expr(`"status" IN ('open', 'closed')`))).toEqual({ column: "status", values: ["open", "closed"] });
  });

  it("reads pg_dump's = ANY (ARRAY[...]) with casts", () => {
    const e = expr(`((kind)::text = ANY ((ARRAY['a'::character varying, 'b'::character varying])::text[]))`);
    expect(checkValues(e)).toEqual({ column: "kind", values: ["a", "b"] });
  });

  it("reads a single = and OR chains, allowing IS NULL", () => {
    expect(checkValues(expr(`method = 'card'`))).toEqual({ column: "method", values: ["card"] });
    expect(checkValues(expr(`size = 's' OR size = 'm' OR size IS NULL`))).toEqual({ column: "size", values: ["s", "m"] });
  });

  it("returns null for anything else", () => {
    expect(checkValues(expr(`qty >= 0`))).toBeNull();
    expect(checkValues(expr(`code ~ '^[a-z]+$'`))).toBeNull();
    expect(checkValues(expr(`a = 'x' OR b = 'y'`))).toBeNull();
    expect(checkValues(expr(`status NOT IN ('x')`))).toBeNull();
    expect(checkValues(expr(`n IN (1, 2)`))).toBeNull();
  });
});
