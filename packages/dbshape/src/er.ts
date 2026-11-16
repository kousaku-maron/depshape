import type { ErColumn, ErForeignKey, ErStatus, ErTable, SchemaDiff } from "./model.js";
import type { Schema, Table } from "./schema.js";

/*
 * The tables for the ER diagram: every table on the target side and the removed ones from the base
 * side, each column and foreign key marked with how it changed. Tables from files that failed to
 * parse are left out, as in the diff.
 */

function foreignKeys(t: Table): ErForeignKey[] {
  return t.constraints
    .filter((c) => c.view.kind === "foreign" && c.view.references)
    .map((c) => ({ name: c.view.name, columns: c.view.columns, table: c.view.references!.table, refColumns: c.view.references!.columns, status: "unchanged" as ErStatus }));
}

function primaryColumns(t: Table): Set<string> {
  return new Set(t.constraints.filter((c) => c.view.kind === "primary").flatMap((c) => c.view.columns));
}

export function erTables(before: Schema, after: Schema, diff: SchemaDiff): ErTable[] {
  const skip = new Set([...before.errors.keys(), ...after.errors.keys()]);
  const changes = new Map(diff.tables.map((t) => [t.name, t]));
  const valueColumns = new Set<string>();
  for (const v of diff.values) {
    if (v.source === "check" && v.table && v.column) valueColumns.add(`${v.table}.${v.column}`);
    for (const u of v.usedBy ?? []) valueColumns.add(u);
  }

  const out: ErTable[] = [];
  const names = [...new Set([...after.tables.keys(), ...before.tables.keys()])].sort();
  for (const name of names) {
    const a = after.tables.get(name);
    const b = before.tables.get(name);
    if ((a && skip.has(a.file)) || (b && skip.has(b.file))) continue;
    const t = (a ?? b)!;
    const change = changes.get(name);
    const status: ErStatus = change?.status ?? "unchanged";
    const pk = primaryColumns(t);
    const colStatus = new Map(change?.columns.map((c) => [c.name, c]) ?? []);

    const columns: ErColumn[] = t.columns.map((c) => {
      const ch = colStatus.get(c.view.name);
      const s: ErStatus = status === "added" || status === "removed" ? status : (ch?.status ?? "unchanged");
      const typeChanged = ch?.status === "modified" && ch.changed?.includes("type");
      return {
        name: c.view.name,
        type: c.view.type,
        ...(typeChanged && { beforeType: ch!.before!.type }),
        status: s,
        notNull: c.view.notNull,
        primary: pk.has(c.view.name),
        ...(valueColumns.has(`${name}.${c.view.name}`) && { values: true }),
      };
    });
    // columns removed from a table that still exists, at the end
    if (a && b) {
      const bpk = primaryColumns(b);
      for (const c of change?.columns ?? []) {
        if (c.status !== "removed") continue;
        columns.push({ name: c.name, type: c.before!.type, status: "removed", notNull: c.before!.notNull, primary: bpk.has(c.name) });
      }
    }

    const fks = foreignKeys(t).map((fk) => ({ ...fk, status: status === "added" || status === "removed" ? status : fk.status }));
    let other = { constraints: 0, indexes: 0, comment: false };
    if (change && a && b) {
      const fkChange = new Map(change.constraints.filter((c) => c.kind === "foreign").map((c) => [c.name, c.status]));
      for (const fk of fks) fk.status = fkChange.get(fk.name) ?? "unchanged";
      for (const c of change.constraints) {
        if (c.kind === "foreign" && c.status === "removed" && c.before?.references) {
          fks.push({ name: c.name, columns: c.before.columns, table: c.before.references.table, refColumns: c.before.references.columns, status: "removed" });
        }
      }
      other = {
        constraints: change.constraints.filter((c) => c.kind !== "foreign").length,
        indexes: change.indexes.length,
        comment: !!change.comment,
      };
    }
    out.push({ name, schema: t.schema, table: t.name, status, columns, foreignKeys: fks, otherChanges: other });
  }
  return out;
}
