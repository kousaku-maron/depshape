/*
 * Turning parts of the PostgreSQL parse tree back into short SQL text for display, and into keys for
 * comparison. Display text is best effort (unknown nodes print as ‹NodeName›); comparisons always use
 * the keys, which are the parse tree itself without source positions, so formatting never counts as
 * a change and nothing is missed when the printer does not know a node.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Node = any;

const POSITION_KEYS = new Set(["location", "stmt_location", "stmt_len", "rexpr_list_start", "rexpr_list_end"]);

/** A comparison key for a parse tree node (positions removed). */
export function nodeKey(n: unknown): string {
  return JSON.stringify(n ?? null, (k, v) => (POSITION_KEYS.has(k) ? undefined : v));
}

/** The text of a String node (or a bare { sval }). */
export function str(n: Node): string {
  return n?.String?.sval ?? n?.sval ?? "";
}

/** The single key of a parse tree node: { A_Const: {...} } → ["A_Const", {...}] */
function unwrap(n: Node): [string, Node] {
  const k = Object.keys(n ?? {})[0];
  return [k ?? "", k ? n[k] : undefined];
}

const SIMPLE_IDENT = /^[a-z_][a-z0-9_$]*$/;

export function ident(name: string): string {
  return SIMPLE_IDENT.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

const CATALOG_TYPES: Record<string, string> = {
  int2: "smallint",
  int4: "integer",
  int8: "bigint",
  float4: "real",
  float8: "double precision",
  bool: "boolean",
  bpchar: "char",
};

/** Internal names that mean the same built-in type whether written bare (`int4`) or as SQL (`integer`). */
const CATALOG_NAMES = new Set(["int2", "int4", "int8", "float4", "float8", "bool", "varchar", "bpchar", "numeric", "timestamp", "timestamptz", "time", "timetz", "interval", "bit", "varbit"]);

function typeNames(t: Node): string[] {
  const names: string[] = (t?.names ?? []).map(str);
  return names.length === 1 && CATALOG_NAMES.has(names[0]) ? ["pg_catalog", names[0]] : names;
}

/** Display text for a TypeName node: "varchar", "numeric(12,2)", "text[]", "billing.mood" */
export function typeText(t: Node): string {
  const names = typeNames(t);
  let name = names.length === 2 && names[0] === "pg_catalog" ? (CATALOG_TYPES[names[1]] ?? names[1]) : names.map(ident).join(".");
  const mods = (t?.typmods ?? []).map(exprText);
  if (mods.length && !name.startsWith("interval")) name += `(${mods.join(",")})`;
  if (t?.arrayBounds?.length) name += "[]".repeat(t.arrayBounds.length);
  if (t?.setof) name = `SETOF ${name}`;
  return name;
}

/** Comparison key for a type: the names and modifiers, so "character varying" and "varchar" are equal. */
export function typeKey(t: Node): string {
  return nodeKey({ names: typeNames(t), typmods: t?.typmods, arrayBounds: t?.arrayBounds });
}

function constText(c: Node): string {
  if (c.isnull) return "NULL";
  if (c.sval) return `'${(c.sval.sval ?? "").replace(/'/g, "''")}'`;
  if (c.ival) return String(c.ival.ival ?? 0);
  if (c.fval) return c.fval.fval ?? "0";
  if (c.boolval) return c.boolval.boolval ? "true" : "false";
  if (c.bsval) return c.bsval.bsval ?? "";
  return "NULL";
}

const SVF: Record<string, string> = {
  SVFOP_CURRENT_DATE: "CURRENT_DATE",
  SVFOP_CURRENT_TIME: "CURRENT_TIME",
  SVFOP_CURRENT_TIMESTAMP: "CURRENT_TIMESTAMP",
  SVFOP_LOCALTIME: "LOCALTIME",
  SVFOP_LOCALTIMESTAMP: "LOCALTIMESTAMP",
  SVFOP_CURRENT_ROLE: "CURRENT_ROLE",
  SVFOP_CURRENT_USER: "CURRENT_USER",
  SVFOP_USER: "USER",
  SVFOP_SESSION_USER: "SESSION_USER",
  SVFOP_CURRENT_CATALOG: "CURRENT_CATALOG",
  SVFOP_CURRENT_SCHEMA: "CURRENT_SCHEMA",
};

function wrap(n: Node): string {
  const [k] = unwrap(n);
  return k === "A_Expr" || k === "BoolExpr" ? `(${exprText(n)})` : exprText(n);
}

function opName(names: Node[] | undefined): string {
  return (names ?? []).map(str).filter((s) => s !== "pg_catalog").join(".");
}

/** Display text for an expression node (best effort). */
export function exprText(n: Node): string {
  if (n === undefined || n === null) return "";
  const [k, v] = unwrap(n);
  switch (k) {
    case "A_Const":
      return constText(v);
    case "Integer":
      return String(v.ival ?? 0);
    case "String":
      return v.sval ?? "";
    case "ColumnRef":
      return (v.fields ?? []).map((f: Node) => (f.A_Star ? "*" : ident(str(f)))).join(".");
    case "TypeCast":
      return `${wrap(v.arg)}::${typeText(v.typeName)}`;
    case "FuncCall": {
      const name = (v.funcname ?? []).map(str).filter((s: string) => s !== "pg_catalog").join(".");
      const args = v.agg_star ? "*" : (v.args ?? []).map(exprText).join(", ");
      return `${name}(${args})`;
    }
    case "A_Expr": {
      const op = opName(v.name);
      switch (v.kind) {
        case "AEXPR_OP":
          return v.lexpr ? `${wrap(v.lexpr)} ${op} ${wrap(v.rexpr)}` : `${op} ${wrap(v.rexpr)}`;
        case "AEXPR_OP_ANY":
          return `${wrap(v.lexpr)} ${op} ANY (${exprText(v.rexpr)})`;
        case "AEXPR_OP_ALL":
          return `${wrap(v.lexpr)} ${op} ALL (${exprText(v.rexpr)})`;
        case "AEXPR_IN":
          return `${wrap(v.lexpr)} ${op === "=" ? "IN" : "NOT IN"} (${exprText(v.rexpr)})`;
        case "AEXPR_BETWEEN":
        case "AEXPR_NOT_BETWEEN": {
          const [lo, hi] = v.rexpr?.List?.items ?? [];
          return `${wrap(v.lexpr)} ${v.kind === "AEXPR_BETWEEN" ? "BETWEEN" : "NOT BETWEEN"} ${wrap(lo)} AND ${wrap(hi)}`;
        }
        case "AEXPR_LIKE":
          return `${wrap(v.lexpr)} ${op === "~~" ? "LIKE" : "NOT LIKE"} ${wrap(v.rexpr)}`;
        case "AEXPR_ILIKE":
          return `${wrap(v.lexpr)} ${op === "~~*" ? "ILIKE" : "NOT ILIKE"} ${wrap(v.rexpr)}`;
        case "AEXPR_DISTINCT":
          return `${wrap(v.lexpr)} IS DISTINCT FROM ${wrap(v.rexpr)}`;
        case "AEXPR_NOT_DISTINCT":
          return `${wrap(v.lexpr)} IS NOT DISTINCT FROM ${wrap(v.rexpr)}`;
        case "AEXPR_NULLIF":
          return `NULLIF(${exprText(v.lexpr)}, ${exprText(v.rexpr)})`;
        default:
          return `${wrap(v.lexpr)} ${op} ${wrap(v.rexpr)}`;
      }
    }
    case "BoolExpr": {
      const args = (v.args ?? []).map(wrap);
      if (v.boolop === "NOT_EXPR") return `NOT ${args[0]}`;
      return args.join(v.boolop === "AND_EXPR" ? " AND " : " OR ");
    }
    case "NullTest":
      return `${wrap(v.arg)} IS ${v.nulltesttype === "IS_NOT_NULL" ? "NOT " : ""}NULL`;
    case "BooleanTest":
      return `${wrap(v.arg)} ${String(v.booltesttype ?? "").replace(/_/g, " ")}`;
    case "A_ArrayExpr":
      return `ARRAY[${(v.elements ?? []).map(exprText).join(", ")}]`;
    case "List":
      return (v.items ?? []).map(exprText).join(", ");
    case "SQLValueFunction":
      return SVF[v.op] ?? String(v.op ?? "");
    case "CoalesceExpr":
      return `COALESCE(${(v.args ?? []).map(exprText).join(", ")})`;
    case "MinMaxExpr":
      return `${v.op === "IS_LEAST" ? "LEAST" : "GREATEST"}(${(v.args ?? []).map(exprText).join(", ")})`;
    case "ParamRef":
      return `$${v.number ?? 0}`;
    case "CaseExpr": {
      const whens = (v.args ?? []).map((w: Node) => `WHEN ${exprText(w.CaseWhen?.expr)} THEN ${exprText(w.CaseWhen?.result)}`);
      return `CASE ${v.arg ? `${exprText(v.arg)} ` : ""}${whens.join(" ")}${v.defresult ? ` ELSE ${exprText(v.defresult)}` : ""} END`;
    }
    case "RowExpr":
      return `ROW(${(v.args ?? []).map(exprText).join(", ")})`;
    case "CollateClause":
      return `${wrap(v.arg)} COLLATE ${(v.collname ?? []).map(str).join(".")}`;
    default:
      return `‹${k}›`;
  }
}
