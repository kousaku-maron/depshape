import type {
  ColumnChange,
  ConstraintChange,
  ConstraintView,
  DomainChange,
  EnumChange,
  IndexChange,
  SchemaDiff,
  TableChange,
  ValueChange,
} from "./model.js";
import type { Column, Constraint, Index, Schema, Table } from "./schema.js";

/*
 * Comparing two schemas. Only what changed is listed; an added or removed table lists every part with
 * that status, so its whole shape can be shown. Value changes are reported for columns that exist on
 * both sides (a new table's CHECK values are part of the new table, not a change to review).
 */

const byName = <T>(items: T[], name: (t: T) => string) => new Map(items.map((i) => [name(i), i]));

function setDiff(before: string[], after: string[]) {
  const b = new Set(before);
  const a = new Set(after);
  return { added: after.filter((v) => !b.has(v)), removed: before.filter((v) => !a.has(v)) };
}

function columnChanges(before: Column[], after: Column[]): ColumnChange[] {
  const out: ColumnChange[] = [];
  const b = byName(before, (c) => c.view.name);
  const a = byName(after, (c) => c.view.name);
  for (const c of after) {
    const old = b.get(c.view.name);
    if (!old) {
      out.push({ name: c.view.name, status: "added", after: c.view });
      continue;
    }
    const changed: ColumnChange["changed"] = [];
    if (old.key.type !== c.key.type) changed.push("type");
    if (old.view.notNull !== c.view.notNull) changed.push("notNull");
    if (old.key.default !== c.key.default) changed.push("default");
    if (old.view.identity !== c.view.identity) changed.push("identity");
    if (old.key.generated !== c.key.generated) changed.push("generated");
    if (old.view.comment !== c.view.comment) changed.push("comment");
    if (changed.length) out.push({ name: c.view.name, status: "modified", before: old.view, after: c.view, changed });
  }
  for (const c of before) if (!a.has(c.view.name)) out.push({ name: c.view.name, status: "removed", before: c.view });
  return out;
}

function constraintChanges(before: Constraint[], after: Constraint[]): ConstraintChange[] {
  const out: ConstraintChange[] = [];
  const b = byName(before, (c) => c.view.name);
  const a = byName(after, (c) => c.view.name);
  for (const c of after) {
    const old = b.get(c.view.name);
    if (!old) out.push({ name: c.view.name, kind: c.view.kind, status: "added", after: c.view });
    else if (old.key !== c.key) out.push({ name: c.view.name, kind: c.view.kind, status: "modified", before: old.view, after: c.view });
  }
  for (const c of before) if (!a.has(c.view.name)) out.push({ name: c.view.name, kind: c.view.kind, status: "removed", before: c.view });
  return out;
}

function indexChanges(before: Index[], after: Index[]): IndexChange[] {
  const out: IndexChange[] = [];
  const b = byName(before, (i) => i.view.name);
  const a = byName(after, (i) => i.view.name);
  for (const i of after) {
    const old = b.get(i.view.name);
    if (!old) out.push({ name: i.view.name, status: "added", after: i.view });
    else if (old.key !== i.key) out.push({ name: i.view.name, status: "modified", before: old.view, after: i.view });
  }
  for (const i of before) if (!a.has(i.view.name)) out.push({ name: i.view.name, status: "removed", before: i.view });
  return out;
}

function allOf(t: Table, status: "added" | "removed"): Pick<TableChange, "columns" | "constraints" | "indexes"> {
  const side = status === "added" ? "after" : "before";
  return {
    columns: t.columns.map((c) => ({ name: c.view.name, status, [side]: c.view })),
    constraints: t.constraints.map((c) => ({ name: c.view.name, kind: c.view.kind, status, [side]: c.view })),
    indexes: t.indexes.map((i) => ({ name: i.view.name, status, [side]: i.view })),
  };
}

/** Value changes of the CHECKs on a table that exists on both sides. */
function checkValueChanges(name: string, before: Table, after: Table): ValueChange[] {
  const out: ValueChange[] = [];
  const withValues = (t: Table) => t.constraints.map((c) => c.view).filter((v): v is ConstraintView & { values: NonNullable<ConstraintView["values"]> } => !!v.values);
  const b = withValues(before);
  const a = withValues(after);
  const afterCols = new Set(after.columns.map((c) => c.view.name));
  const beforeCols = new Set(before.columns.map((c) => c.view.name));
  const used = new Set<ConstraintView>();
  // match by constraint name first, then by column (an inline CHECK may get a name, or the other way round)
  const pair = (c: ConstraintView) => {
    const old = b.find((x) => !used.has(x) && x.name === c.name) ?? b.find((x) => !used.has(x) && x.values.column === c.values!.column);
    if (old) used.add(old);
    return old;
  };
  for (const c of a) {
    const old = pair(c);
    const column = c.values!.column;
    if (!old) {
      // a value list on a column that already existed; a new column's CHECK is part of the new column
      if (beforeCols.has(column)) {
        out.push({ source: "check", table: name, column, constraint: c.name, status: "added", added: c.values!.values, removed: [], after: c.values!.values });
      }
      continue;
    }
    const d = setDiff(old.values.values, c.values!.values);
    if (d.added.length || d.removed.length) {
      out.push({ source: "check", table: name, column, constraint: c.name, status: "modified", ...d, before: old.values.values, after: c.values!.values });
    }
  }
  for (const old of b) {
    if (used.has(old)) continue;
    const column = old.values.column;
    if (afterCols.has(column)) {
      out.push({ source: "check", table: name, column, constraint: old.name, status: "removed", added: [], removed: old.values.values, before: old.values.values });
    }
  }
  return out;
}

/** "schema.table.column" for every column whose type is `type` ("schema.name"; an unqualified type name also matches) */
function usersOf(s: Schema, type: string): string[] {
  const short = type.split(".").pop();
  const out: string[] = [];
  for (const [tname, t] of s.tables) {
    for (const c of t.columns) {
      const ct = c.view.type.replace(/\[\]$/, "");
      if (ct === type || ct === short) out.push(`${tname}.${c.view.name}`);
    }
  }
  return out;
}

/**
 * Tables defined in a file that failed to parse on either side are left out, so a syntax error does
 * not show up as every table in the file being removed.
 */
function failedFiles(before: Schema, after: Schema): Set<string> {
  return new Set([...before.errors.keys(), ...after.errors.keys()]);
}

export function diffSchemas(before: Schema, after: Schema): SchemaDiff {
  const skip = failedFiles(before, after);
  const keep = (t: Table) => !skip.has(t.file);
  const tables: TableChange[] = [];
  const values: ValueChange[] = [];
  let unchanged = 0;

  const names = [...new Set([...before.tables.keys(), ...after.tables.keys()])].sort();
  for (const name of names) {
    const b = before.tables.get(name);
    const a = after.tables.get(name);
    if ((b && !keep(b)) || (a && !keep(a))) continue;
    const t = (a ?? b)!;
    const head = { name, schema: t.schema, table: t.name };
    if (!b) {
      tables.push({ ...head, status: "added", file: a!.file, ...allOf(a!, "added"), ...(a!.comment !== undefined && { comment: { after: a!.comment } }) });
      continue;
    }
    if (!a) {
      tables.push({ ...head, status: "removed", file: b.file, ...allOf(b, "removed"), ...(b.comment !== undefined && { comment: { before: b.comment } }) });
      continue;
    }
    const columns = columnChanges(b.columns, a.columns);
    const constraints = constraintChanges(b.constraints, a.constraints);
    const indexes = indexChanges(b.indexes, a.indexes);
    const commentChanged = b.comment !== a.comment;
    values.push(...checkValueChanges(name, b, a));
    if (columns.length || constraints.length || indexes.length || commentChanged) {
      tables.push({
        ...head,
        status: "modified",
        file: a.file,
        columns,
        constraints,
        indexes,
        ...(commentChanged && { comment: { before: b.comment, after: a.comment } }),
        unchanged: {
          columns: a.columns.filter((c) => !columns.some((x) => x.name === c.view.name)).map((c) => c.view),
          constraints: a.constraints.filter((c) => !constraints.some((x) => x.name === c.view.name)).map((c) => c.view),
          indexes: a.indexes.filter((i) => !indexes.some((x) => x.name === i.view.name)).map((i) => i.view),
        },
      });
    } else {
      unchanged++;
    }
  }

  const enums: EnumChange[] = [];
  for (const name of [...new Set([...before.enums.keys(), ...after.enums.keys()])].sort()) {
    const b = before.enums.get(name);
    const a = after.enums.get(name);
    if ((b && skip.has(b.file)) || (a && skip.has(a.file))) continue;
    if (!b) enums.push({ name, status: "added", after: a!.view });
    else if (!a) enums.push({ name, status: "removed", before: b.view });
    else {
      const d = setDiff(b.view.values, a.view.values);
      if (d.added.length || d.removed.length || b.view.values.join("\0") !== a.view.values.join("\0")) {
        enums.push({ name, status: "modified", before: b.view, after: a.view });
      }
      if (d.added.length || d.removed.length) {
        values.push({ source: "enum", type: name, usedBy: usersOf(after, name), status: "modified", ...d, before: b.view.values, after: a.view.values });
      }
    }
  }

  const domains: DomainChange[] = [];
  for (const name of [...new Set([...before.domains.keys(), ...after.domains.keys()])].sort()) {
    const b = before.domains.get(name);
    const a = after.domains.get(name);
    if ((b && skip.has(b.file)) || (a && skip.has(a.file))) continue;
    if (!b) domains.push({ name, status: "added", after: a!.view });
    else if (!a) domains.push({ name, status: "removed", before: b.view });
    else if (b.key !== a.key) {
      domains.push({ name, status: "modified", before: b.view, after: a.view });
      const bv = b.view.checks.flatMap((c) => c.values?.values ?? []);
      const av = a.view.checks.flatMap((c) => c.values?.values ?? []);
      const d = setDiff(bv, av);
      if (d.added.length || d.removed.length) {
        values.push({ source: "domain", type: name, usedBy: usersOf(after, name), status: "modified", ...d, before: bv, after: av });
      }
    }
  }

  return { tables, enums, domains, values, unchangedTables: unchanged };
}
