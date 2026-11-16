import { str, type Node } from "./sql.js";
import type { ValueSet } from "./model.js";

/*
 * Reading the value list of an enum-like CHECK. Only the plain forms count, so the result is a fact
 * the database enforces:
 *   col IN ('a', 'b')
 *   col = ANY (ARRAY['a', 'b'])          (how pg_dump prints IN, often with ::text casts)
 *   col = 'a' OR col = 'b'
 * An `col IS NULL OR ...` part is allowed. Anything else returns null (the CHECK is then shown as an
 * expression that changed, not as values).
 */

function stripCasts(n: Node): Node {
  while (n?.TypeCast) n = n.TypeCast.arg;
  return n;
}

function columnOf(n: Node): string | null {
  const c = stripCasts(n)?.ColumnRef;
  if (!c?.fields?.length) return null;
  const last = c.fields[c.fields.length - 1];
  return last.String ? str(last) : null;
}

function textOf(n: Node): string | null {
  const c = stripCasts(n)?.A_Const;
  return c?.sval ? (c.sval.sval ?? "") : null;
}

function texts(nodes: Node[] | undefined): string[] | null {
  if (!nodes?.length) return null;
  const out: string[] = [];
  for (const n of nodes) {
    const t = textOf(n);
    if (t === null) return null;
    out.push(t);
  }
  return out;
}

function arrayItems(n: Node): Node[] | undefined {
  return stripCasts(n)?.A_ArrayExpr?.elements;
}

function eqName(e: Node): boolean {
  const names = (e.name ?? []).map(str);
  return names.length === 1 && names[0] === "=";
}

export function checkValues(expr: Node): ValueSet | null {
  const e = expr?.A_Expr;
  if (e && eqName(e)) {
    if (e.kind === "AEXPR_IN") {
      const column = columnOf(e.lexpr);
      const values = texts(e.rexpr?.List?.items);
      return column && values ? { column, values } : null;
    }
    if (e.kind === "AEXPR_OP_ANY") {
      const column = columnOf(e.lexpr);
      const values = texts(arrayItems(e.rexpr));
      return column && values ? { column, values } : null;
    }
    if (e.kind === "AEXPR_OP") {
      const column = columnOf(e.lexpr) ?? columnOf(e.rexpr);
      const value = textOf(e.rexpr) ?? textOf(e.lexpr);
      return column && value !== null ? { column, values: [value] } : null;
    }
    return null;
  }
  const b = expr?.BoolExpr;
  if (b?.boolop === "OR_EXPR") {
    let column: string | null = null;
    const values: string[] = [];
    let nullTests = 0;
    for (const arg of b.args ?? []) {
      if (arg.NullTest?.nulltesttype === "IS_NULL") {
        nullTests++;
        const c = columnOf(arg.NullTest.arg);
        if (!c || (column && c !== column)) return null;
        column = c;
        continue;
      }
      const part = checkValues(arg);
      if (!part || (column && part.column !== column)) return null;
      column = part.column;
      values.push(...part.values);
    }
    if (!column || values.length === 0 || nullTests > 1) return null;
    return { column, values: [...new Set(values)] };
  }
  return null;
}
