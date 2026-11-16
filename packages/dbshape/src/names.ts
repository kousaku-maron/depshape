import type { DbShapeResult, SchemaFrom } from "./model.js";

/** "db/atlas.hcl の src", "db/atlas.hcl（env: app）の src" or "--schema db/*.sql" */
export function schemaFromText(f: SchemaFrom): string {
  if (f.kind === "option") return `--schema ${f.patterns.join(" ")}`;
  const envs = f.envs?.filter(Boolean) ?? [];
  return `${f.configs.join(", ")}${envs.length ? `（env: ${envs.join(", ")}）` : ""} の src`;
}

/** How many things changed in a database (tables, values, types) */
export const changeCount = (d: DbShapeResult) => d.diff.tables.length + d.diff.values.length + d.diff.enums.length + d.diff.domains.length;
