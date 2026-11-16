import { checkValues } from "./checks.js";
import type { ColumnView, ConstraintKind, ConstraintView, DomainView, EnumView, IndexView } from "./model.js";
import { exprText, ident, nodeKey, str, typeKey, typeText, type Node } from "./sql.js";

/*
 * The schema a set of SQL files describes: tables (columns, constraints, indexes), enum types and
 * domains. Statements are applied in order, the way PostgreSQL would run them, so both a CREATE TABLE
 * with inline constraints and pg_dump's CREATE TABLE + ALTER TABLE ONLY ... ADD CONSTRAINT give the
 * same model. Each comparable part keeps a key (its parse tree without positions) next to its display.
 */

/** Where a part is defined: file and 1-based line */
export interface Loc {
  file: string;
  line: number;
}

export interface Column {
  view: ColumnView;
  loc: Loc;
  key: { type: string; default?: string; generated?: string };
}

export interface Constraint {
  view: ConstraintView;
  loc: Loc;
  key: string;
}

export interface Index {
  view: IndexView;
  loc: Loc;
  key: string;
}

export interface Table {
  schema: string;
  name: string;
  file: string;
  loc: Loc;
  columns: Column[];
  constraints: Constraint[];
  indexes: Index[];
  comment?: string;
}

export interface EnumType {
  view: EnumView;
  file: string;
  loc: Loc;
}

export interface Domain {
  view: DomainView;
  file: string;
  loc: Loc;
  key: string;
}

export interface Schema {
  tables: Map<string, Table>;
  enums: Map<string, EnumType>;
  domains: Map<string, Domain>;
  /** Statement kinds read but not modelled, with counts */
  ignored: Map<string, number>;
  /** Files that failed to parse, with the error */
  errors: Map<string, string>;
  /** Notes about statements that could not be applied (e.g. ALTER of an unknown table) */
  notes: string[];
}

export interface SqlFile {
  path: string;
  sql: string;
}

export type Parser = (sql: string) => Node;

const qualified = (schema: string, name: string) => `${schema}.${name}`;

const FK_ACTIONS: Record<string, string> = { r: "RESTRICT", c: "CASCADE", n: "SET NULL", d: "SET DEFAULT" };

/** The first column an expression mentions (PostgreSQL names an unnamed CHECK after it). */
function firstColumn(n: Node): string | undefined {
  if (!n || typeof n !== "object") return undefined;
  if (n.ColumnRef) {
    const last = n.ColumnRef.fields?.at(-1);
    return last?.String ? str(last) : undefined;
  }
  for (const v of Object.values(n)) {
    const found = Array.isArray(v) ? v.map(firstColumn).find(Boolean) : firstColumn(v);
    if (found) return found;
  }
  return undefined;
}

function names(list: Node[] | undefined): string[] {
  return (list ?? []).map(str);
}

export function buildSchema(files: SqlFile[], parse: Parser): Schema {
  const s: Schema = {
    tables: new Map(),
    enums: new Map(),
    domains: new Map(),
    ignored: new Map(),
    errors: new Map(),
    notes: [],
  };
  for (const f of files) {
    let tree: Node;
    try {
      tree = parse(f.sql);
    } catch (e) {
      s.errors.set(f.path, e instanceof Error ? e.message : String(e));
      continue;
    }
    new FileReader(s, f.path, f.sql).run(tree);
  }
  return s;
}

/**
 * Byte offsets (what the parser reports) to 1-based lines. A statement's offset may point at the
 * whitespace and comments before it, so those can be skipped.
 */
export class Lines {
  private bytes: Uint8Array;
  private breaks: number[] = [];

  constructor(sql: string) {
    this.bytes = new TextEncoder().encode(sql);
    this.bytes.forEach((b, i) => b === 10 && this.breaks.push(i));
  }

  /** The line of a byte offset, after skipping whitespace and comments when `skip` is set */
  lineAt(offset: number, skip = false): number {
    const b = this.bytes;
    let i = Math.max(0, offset);
    while (skip && i < b.length) {
      if (b[i] === 32 || b[i] === 9 || b[i] === 10 || b[i] === 13) i++;
      else if (b[i] === 45 && b[i + 1] === 45) while (i < b.length && b[i] !== 10) i++;
      else if (b[i] === 47 && b[i + 1] === 42) {
        // a block comment: up to the next "*/"
        let j = i + 2;
        while (j < b.length && !(b[j] === 42 && b[j + 1] === 47)) j++;
        i = j + 2;
      } else break;
    }
    // number of line breaks before i
    let lo = 0;
    let hi = this.breaks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.breaks[mid] < i) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  }
}

class FileReader {
  private searchPath = "public";
  private lines: Lines;
  /** Where the current statement starts */
  private here: Loc;

  constructor(
    private s: Schema,
    private file: string,
    sql: string,
  ) {
    this.lines = new Lines(sql);
    this.here = { file, line: 1 };
  }

  run(tree: Node) {
    for (const st of tree?.stmts ?? []) {
      const [kind, v] = Object.entries(st.stmt ?? {})[0] ?? [];
      if (!kind) continue;
      this.here = { file: this.file, line: this.lines.lineAt(st.stmt_location ?? 0, true) };
      this.statement(kind, v);
    }
  }

  /** The location of a node inside the current statement (or the statement itself) */
  private at(location: number | undefined): Loc {
    return typeof location === "number" && location >= 0 ? { file: this.file, line: this.lines.lineAt(location) } : this.here;
  }

  private ignore(what: string) {
    this.s.ignored.set(what, (this.s.ignored.get(what) ?? 0) + 1);
  }

  private note(msg: string) {
    this.s.notes.push(`${this.file}: ${msg}`);
  }

  private rel(r: Node): { schema: string; name: string; key: string } {
    const schema = r?.schemaname || this.searchPath;
    const name = r?.relname ?? "";
    return { schema, name, key: qualified(schema, name) };
  }

  /** "schema.name" from a list of String nodes (enum / domain names) */
  private typeName(list: Node[]): string {
    const n = names(list);
    return n.length > 1 ? n.join(".") : qualified(this.searchPath, n[0] ?? "");
  }

  private table(r: Node, what: string): Table | undefined {
    const { key } = this.rel(r);
    const t = this.s.tables.get(key);
    if (!t) this.note(`${what}: テーブル ${key} が見つかりません`);
    return t;
  }

  private statement(kind: string, v: Node) {
    switch (kind) {
      case "VariableSetStmt":
        if (v.name === "search_path") {
          const first = (v.args ?? []).map((a: Node) => a.A_Const?.sval?.sval).find((x: string | undefined) => x && x !== "$user");
          if (v.kind === "VAR_SET_VALUE" && first) this.searchPath = first;
          if (v.kind === "VAR_RESET" || v.kind === "VAR_SET_DEFAULT") this.searchPath = "public";
        }
        return;
      case "CreateSchemaStmt":
        return;
      case "CreateStmt":
        return this.createTable(v);
      case "AlterTableStmt":
        if (v.objtype === "OBJECT_TABLE" || v.objtype === undefined) return this.alterTable(v);
        return this.ignore(`ALTER ${String(v.objtype).replace("OBJECT_", "")}`);
      case "IndexStmt":
        return this.createIndex(v);
      case "CreateEnumStmt":
        return this.createEnum(v);
      case "AlterEnumStmt":
        return this.alterEnum(v);
      case "CreateDomainStmt":
        return this.createDomain(v);
      case "RenameStmt":
        return this.rename(v);
      case "CommentStmt":
        return this.comment(v);
      default:
        return this.ignore(kind.replace(/Stmt$/, ""));
    }
  }

  // ---- tables

  private createTable(v: Node) {
    const { schema, name, key } = this.rel(v.relation);
    if (this.s.tables.has(key)) {
      if (!v.if_not_exists) this.note(`テーブル ${key} が2回定義されています`);
      return;
    }
    const t: Table = { schema, name, file: this.file, loc: this.here, columns: [], constraints: [], indexes: [] };
    this.s.tables.set(key, t);
    for (const el of v.tableElts ?? []) {
      if (el.ColumnDef) this.addColumn(t, el.ColumnDef);
      else if (el.Constraint) this.addConstraint(t, el.Constraint);
      else this.ignore(`CREATE TABLE の ${Object.keys(el)[0]}`);
    }
    // a table-level PRIMARY KEY may name a column defined after it
    for (const c of t.constraints) if (c.view.kind === "primary") this.setNotNull(t, c.view.columns);
  }

  /** PostgreSQL makes primary key columns NOT NULL even when the SQL doesn't say so. */
  private setNotNull(t: Table, columns: string[]) {
    for (const c of t.columns) if (columns.includes(c.view.name)) c.view.notNull = true;
  }

  private addColumn(t: Table, c: Node) {
    const view: ColumnView = { name: c.colname, type: typeText(c.typeName), notNull: false };
    const col: Column = { view, loc: this.at(c.location), key: { type: typeKey(c.typeName) } };
    t.columns = t.columns.filter((x) => x.view.name !== c.colname);
    t.columns.push(col);
    for (const k of c.constraints ?? []) {
      const con = k.Constraint;
      switch (con?.contype) {
        case "CONSTR_NOTNULL":
          view.notNull = true;
          break;
        case "CONSTR_NULL":
          view.notNull = false;
          break;
        case "CONSTR_DEFAULT":
          view.default = exprText(con.raw_expr);
          col.key.default = nodeKey(con.raw_expr);
          break;
        case "CONSTR_IDENTITY":
          view.identity = con.generated_when === "a" ? "always" : "by default";
          break;
        case "CONSTR_GENERATED":
          view.generated = exprText(con.raw_expr);
          col.key.generated = nodeKey(con.raw_expr);
          break;
        case "CONSTR_PRIMARY":
        case "CONSTR_UNIQUE":
        case "CONSTR_CHECK":
        case "CONSTR_FOREIGN":
          this.addConstraint(t, con, c.colname);
          break;
        default:
          break; // deferrable attributes, collations, ...
      }
    }
    // identity columns are NOT NULL too
    if (view.identity) view.notNull = true;
  }

  /** PostgreSQL's default name for an unnamed constraint */
  private defaultName(t: Table, kind: ConstraintKind, cols: string[]): string {
    const suffix = { primary: "pkey", unique: "key", foreign: "fkey", check: "check", exclude: "excl" }[kind];
    const base = kind === "primary" ? `${t.name}_pkey` : [t.name, ...cols.slice(0, 1).concat(kind === "check" ? [] : cols.slice(1)), suffix].join("_");
    let name = base;
    for (let i = 1; t.constraints.some((c) => c.view.name === name); i++) name = `${base}${i}`;
    return name;
  }

  private addConstraint(t: Table, c: Node, column?: string) {
    const kind = (
      {
        CONSTR_PRIMARY: "primary",
        CONSTR_UNIQUE: "unique",
        CONSTR_CHECK: "check",
        CONSTR_FOREIGN: "foreign",
        CONSTR_EXCLUSION: "exclude",
      } as Record<string, ConstraintKind>
    )[c.contype];
    if (!kind) return;

    let columns: string[];
    let definition: string;
    let key: string;
    let references: ConstraintView["references"];
    let values: ConstraintView["values"];
    switch (kind) {
      case "primary":
      case "unique": {
        columns = column ? [column] : names(c.keys);
        const include = names(c.including);
        definition = `${kind === "primary" ? "PRIMARY KEY" : "UNIQUE"}${c.nulls_not_distinct ? " NULLS NOT DISTINCT" : ""} (${columns.map(ident).join(", ")})${include.length ? ` INCLUDE (${include.map(ident).join(", ")})` : ""}`;
        key = nodeKey({ kind, columns, include, nnd: c.nulls_not_distinct });
        break;
      }
      case "check": {
        values = checkValues(c.raw_expr) ?? undefined;
        const first = firstColumn(c.raw_expr);
        columns = column ? [column] : values ? [values.column] : first ? [first] : [];
        definition = `CHECK (${exprText(c.raw_expr)})${c.skip_validation ? " NOT VALID" : ""}`;
        key = nodeKey({ kind, expr: c.raw_expr });
        break;
      }
      case "foreign": {
        columns = column ? [column] : names(c.fk_attrs);
        const ref = this.rel(c.pktable);
        const refCols = names(c.pk_attrs);
        const onDelete = FK_ACTIONS[c.fk_del_action];
        const onUpdate = FK_ACTIONS[c.fk_upd_action];
        references = { table: ref.key, columns: refCols, ...(onDelete && { onDelete }), ...(onUpdate && { onUpdate }) };
        definition =
          `FOREIGN KEY (${columns.map(ident).join(", ")}) REFERENCES ${ident(ref.schema)}.${ident(ref.name)}` +
          (refCols.length ? ` (${refCols.map(ident).join(", ")})` : "") +
          (onDelete ? ` ON DELETE ${onDelete}` : "") +
          (onUpdate ? ` ON UPDATE ${onUpdate}` : "") +
          (c.deferrable ? " DEFERRABLE" : "");
        key = nodeKey({ kind, columns, ref: references, match: c.fk_matchtype, deferrable: c.deferrable, initdeferred: c.initdeferred });
        break;
      }
      case "exclude":
        columns = [];
        definition = `EXCLUDE USING ${c.access_method ?? "gist"} (…)`;
        key = nodeKey({ kind, c: { ...c, conname: undefined } });
        break;
    }
    const name = c.conname || this.defaultName(t, kind, columns);
    const view: ConstraintView = { name, kind, columns, definition, ...(references && { references }), ...(values && { values }) };
    t.constraints = t.constraints.filter((x) => x.view.name !== name);
    t.constraints.push({ view, key, loc: this.at(c.location) });
    // dropping the key later leaves the columns NOT NULL, as in PostgreSQL
    if (kind === "primary") this.setNotNull(t, columns);
  }

  private alterTable(v: Node) {
    const t = this.table(v.relation, "ALTER TABLE");
    if (!t) return;
    for (const item of v.cmds ?? []) {
      const cmd = item.AlterTableCmd;
      if (!cmd) continue;
      const col = () => t.columns.find((c) => c.view.name === cmd.name);
      switch (cmd.subtype) {
        case "AT_AddColumn":
          if (cmd.def?.ColumnDef) this.addColumn(t, cmd.def.ColumnDef);
          break;
        case "AT_DropColumn":
          t.columns = t.columns.filter((c) => c.view.name !== cmd.name);
          // like PostgreSQL, constraints and indexes on the column go with it
          t.constraints = t.constraints.filter((c) => !c.view.columns.includes(cmd.name));
          t.indexes = t.indexes.filter((i) => !i.view.columns.includes(cmd.name));
          break;
        case "AT_AlterColumnType": {
          const c = col();
          const tn = cmd.def?.ColumnDef?.typeName;
          if (c && tn) {
            c.view.type = typeText(tn);
            c.key.type = typeKey(tn);
          }
          break;
        }
        case "AT_SetNotNull":
        case "AT_DropNotNull": {
          const c = col();
          if (c) c.view.notNull = cmd.subtype === "AT_SetNotNull";
          break;
        }
        case "AT_ColumnDefault": {
          const c = col();
          if (!c) break;
          if (cmd.def) {
            c.view.default = exprText(cmd.def);
            c.key.default = nodeKey(cmd.def);
          } else {
            delete c.view.default;
            delete c.key.default;
          }
          break;
        }
        case "AT_AddConstraint":
          if (cmd.def?.Constraint) this.addConstraint(t, cmd.def.Constraint);
          break;
        case "AT_DropConstraint":
          t.constraints = t.constraints.filter((c) => c.view.name !== cmd.name);
          break;
        default:
          this.ignore(`ALTER TABLE ${String(cmd.subtype).replace(/^AT_/, "")}`);
      }
    }
  }

  private createIndex(v: Node) {
    const t = this.table(v.relation, "CREATE INDEX");
    if (!t) return;
    const columns = (v.indexParams ?? []).map((p: Node) => {
      const e = p.IndexElem ?? {};
      let text = e.name ? ident(e.name) : `(${exprText(e.expr)})`;
      if (e.expr?.FuncCall) text = exprText(e.expr);
      if (e.ordering === "SORTBY_DESC") text += " DESC";
      if (e.nulls_ordering === "SORTBY_NULLS_FIRST") text += " NULLS FIRST";
      if (e.nulls_ordering === "SORTBY_NULLS_LAST") text += " NULLS LAST";
      return text;
    });
    const include = (v.indexIncludingParams ?? []).map((p: Node) => p.IndexElem?.name ?? "");
    const name = v.idxname || `${t.name}_${columns.map((c: string) => c.replace(/\W+/g, "_")).join("_")}_idx`;
    const view: IndexView = {
      name,
      unique: !!v.unique,
      ...(v.accessMethod && v.accessMethod !== "btree" && { method: v.accessMethod }),
      columns,
      ...(include.length && { include }),
      ...(v.whereClause && { where: exprText(v.whereClause) }),
    };
    const key = nodeKey({
      unique: v.unique,
      method: v.accessMethod ?? "btree",
      params: v.indexParams,
      include: v.indexIncludingParams,
      where: v.whereClause,
      nnd: v.nulls_not_distinct,
    });
    t.indexes = t.indexes.filter((i) => i.view.name !== name);
    t.indexes.push({ view, key, loc: this.here });
  }

  // ---- types

  private createEnum(v: Node) {
    const name = this.typeName(v.typeName);
    this.s.enums.set(name, { view: { name, values: names(v.vals) }, file: this.file, loc: this.here });
  }

  private alterEnum(v: Node) {
    const name = this.typeName(v.typeName);
    const e = this.s.enums.get(name);
    if (!e) return this.note(`ALTER TYPE: 型 ${name} が見つかりません`);
    const vals = e.view.values;
    if (v.oldVal) {
      const i = vals.indexOf(v.oldVal);
      if (i >= 0) vals[i] = v.newVal;
      return;
    }
    if (!v.newVal || vals.includes(v.newVal)) return;
    const at = v.newValNeighbor ? vals.indexOf(v.newValNeighbor) : -1;
    if (at < 0) vals.push(v.newVal);
    else vals.splice(v.newValIsAfter ? at + 1 : at, 0, v.newVal);
  }

  private createDomain(v: Node) {
    const name = this.typeName(v.domainname);
    const view: DomainView = { name, type: typeText(v.typeName), notNull: false, checks: [] };
    const keyParts: unknown[] = [typeKey(v.typeName)];
    for (const k of v.constraints ?? []) {
      const c = k.Constraint;
      if (c?.contype === "CONSTR_NOTNULL") view.notNull = true;
      if (c?.contype === "CONSTR_DEFAULT") view.default = exprText(c.raw_expr);
      if (c?.contype === "CONSTR_CHECK") {
        const values = checkValues(c.raw_expr) ?? undefined;
        view.checks.push({
          name: c.conname || `${names(v.domainname).at(-1)}_check`,
          kind: "check",
          columns: [],
          definition: `CHECK (${exprText(c.raw_expr)})`,
          ...(values && { values }),
        });
      }
      keyParts.push({ ...c, location: undefined });
    }
    this.s.domains.set(name, { view, file: this.file, loc: this.here, key: nodeKey(keyParts) });
  }

  // ---- renames and comments

  private rename(v: Node) {
    switch (v.renameType) {
      case "OBJECT_TABLE": {
        const from = this.rel(v.relation);
        const t = this.s.tables.get(from.key);
        if (!t) return this.note(`RENAME: テーブル ${from.key} が見つかりません`);
        this.s.tables.delete(from.key);
        t.name = v.newname;
        this.s.tables.set(qualified(t.schema, t.name), t);
        return;
      }
      case "OBJECT_COLUMN": {
        const t = this.table(v.relation, "RENAME COLUMN");
        const c = t?.columns.find((x) => x.view.name === v.subname);
        if (!t || !c) return;
        c.view.name = v.newname;
        for (const k of t.constraints) k.view.columns = k.view.columns.map((x) => (x === v.subname ? v.newname : x));
        return;
      }
      case "OBJECT_TABCONSTRAINT": {
        const t = this.table(v.relation, "RENAME CONSTRAINT");
        const c = t?.constraints.find((x) => x.view.name === v.subname);
        if (c) c.view.name = v.newname;
        return;
      }
      default:
        this.ignore(`RENAME ${String(v.renameType).replace("OBJECT_", "")}`);
    }
  }

  private comment(v: Node) {
    const text: string | undefined = v.comment ?? undefined;
    if (v.objtype === "OBJECT_TABLE") {
      const n = names(v.object?.List?.items);
      const key = n.length > 1 ? n.join(".") : qualified(this.searchPath, n[0] ?? "");
      const t = this.s.tables.get(key);
      if (t) t.comment = text;
      return;
    }
    if (v.objtype === "OBJECT_COLUMN") {
      const n = names(v.object?.List?.items);
      const colName = n.pop() ?? "";
      const key = n.length > 1 ? n.join(".") : qualified(this.searchPath, n[0] ?? "");
      const c = this.s.tables.get(key)?.columns.find((x) => x.view.name === colName);
      if (c) {
        if (text === undefined) delete c.view.comment;
        else c.view.comment = text;
      }
      return;
    }
    this.ignore(`COMMENT ON ${String(v.objtype).replace("OBJECT_", "")}`);
  }
}

/**
 * Where every table, column, constraint, index and type is defined, by the keys review comments use:
 * "schema.table", "schema.table.column", "schema.table:constraint_or_index", "schema.type".
 */
export function schemaLocations(s: Schema): Map<string, Loc> {
  const out = new Map<string, Loc>();
  for (const [key, t] of s.tables) {
    out.set(key, t.loc);
    for (const c of t.columns) out.set(`${key}.${c.view.name}`, c.loc);
    for (const c of t.constraints) out.set(`${key}:${c.view.name}`, c.loc);
    for (const i of t.indexes) if (!out.has(`${key}:${i.view.name}`)) out.set(`${key}:${i.view.name}`, i.loc);
  }
  for (const [key, e] of s.enums) out.set(key, e.loc);
  for (const [key, d] of s.domains) out.set(key, d.loc);
  return out;
}
