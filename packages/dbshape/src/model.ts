// Types shared by the analysis, the JSON output and (later) the browser UI.

export type ConstraintKind = "primary" | "unique" | "check" | "foreign" | "exclude";
export type ChangeStatus = "added" | "removed" | "modified";

/** Values an enum-like column may take, read from a CHECK (`IN (...)`, `= ANY (ARRAY[...])`, `= ... OR = ...`). */
export interface ValueSet {
  column: string;
  values: string[];
}

export interface ColumnView {
  name: string;
  /** Display type, e.g. "varchar", "numeric(12,2)", "text[]", "billing.mood" */
  type: string;
  notNull: boolean;
  default?: string;
  identity?: "always" | "by default";
  generated?: string;
  comment?: string;
}

export interface ConstraintView {
  name: string;
  kind: ConstraintKind;
  columns: string[];
  /** The constraint as SQL, e.g. "FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE CASCADE" */
  definition: string;
  references?: { table: string; columns: string[]; onDelete?: string; onUpdate?: string };
  values?: ValueSet;
}

export interface IndexView {
  name: string;
  unique: boolean;
  /** Access method when not btree (gin, gist, ...) */
  method?: string;
  /** Columns or expressions, with DESC / NULLS FIRST when given */
  columns: string[];
  include?: string[];
  where?: string;
}

export interface EnumView {
  name: string;
  values: string[];
}

export interface DomainView {
  name: string;
  type: string;
  notNull: boolean;
  default?: string;
  checks: ConstraintView[];
}

export interface ColumnChange {
  name: string;
  status: ChangeStatus;
  before?: ColumnView;
  after?: ColumnView;
  /** What changed, for modified columns */
  changed?: ("type" | "notNull" | "default" | "identity" | "generated" | "comment")[];
}

export interface ConstraintChange {
  name: string;
  kind: ConstraintKind;
  status: ChangeStatus;
  before?: ConstraintView;
  after?: ConstraintView;
}

export interface IndexChange {
  name: string;
  status: ChangeStatus;
  before?: IndexView;
  after?: IndexView;
}

export interface TableChange {
  /** "schema.table" */
  name: string;
  schema: string;
  table: string;
  status: ChangeStatus;
  /** Schema file that defines the table (target side, or base side for a removed table) */
  file: string;
  /** For added / removed tables every column, constraint and index is listed with that status */
  columns: ColumnChange[];
  constraints: ConstraintChange[];
  indexes: IndexChange[];
  comment?: { before?: string; after?: string };
  /** For modified tables: the parts that did not change (context for the review) */
  unchanged?: { columns: ColumnView[]; constraints: ConstraintView[]; indexes: IndexView[] };
}

export interface EnumChange {
  name: string;
  status: ChangeStatus;
  before?: EnumView;
  after?: EnumView;
}

export interface DomainChange {
  name: string;
  status: ChangeStatus;
  before?: DomainView;
  after?: DomainView;
}

/** A change in the values an existing enum-like column (or enum type / domain) may take. */
export interface ValueChange {
  source: "check" | "enum" | "domain";
  /** "schema.table" for a CHECK */
  table?: string;
  column?: string;
  /** CHECK constraint name */
  constraint?: string;
  /** Enum type / domain name ("schema.name") */
  type?: string;
  /** Columns ("schema.table.column") that use the enum type / domain, on the target side */
  usedBy?: string[];
  /**
   * added = a value list now restricts this column (CHECK added to an existing column)
   * removed = the restriction is gone, modified = values were added / removed
   */
  status: ChangeStatus;
  added: string[];
  removed: string[];
  before?: string[];
  after?: string[];
}

export interface SchemaDiff {
  tables: TableChange[];
  enums: EnumChange[];
  domains: DomainChange[];
  values: ValueChange[];
  unchangedTables: number;
}

// ---- the ER diagram: every table on the target side (plus removed ones) with what changed

export type ErStatus = ChangeStatus | "unchanged";

export interface ErColumn {
  name: string;
  type: string;
  /** The type before, when it changed */
  beforeType?: string;
  status: ErStatus;
  notNull: boolean;
  primary: boolean;
  /** The values this column may take changed (CHECK / enum type / domain) */
  values?: boolean;
}

export interface ErForeignKey {
  name: string;
  columns: string[];
  /** Referenced table, "schema.table" */
  table: string;
  refColumns: string[];
  status: ErStatus;
}

export interface ErTable {
  name: string;
  schema: string;
  table: string;
  status: ErStatus;
  columns: ErColumn[];
  foreignKeys: ErForeignKey[];
  /** Changed constraints other than foreign keys, and changed indexes */
  otherChanges: { constraints: number; indexes: number; comment: boolean };
}

/** Where a part of the schema is defined; `base` = only on the base side (it was removed) */
export interface SourceLocation {
  file: string;
  line: number;
  base?: true;
}

export interface SideInfo {
  label: string;
  files: string[];
}

/** Where a database's schema files came from */
export type SchemaFrom = { kind: "atlas"; configs: string[]; envs?: string[] } | { kind: "option"; patterns: string[] };

/** One database (an atlas.hcl and its env, or a named --schema) compared on both sides */
export interface DbShapeResult {
  /** Stable id ("db/atlas.hcl", "db/atlas.hcl#app", "schema:billing") and a name for the screen */
  database: { id: string; name: string };
  repoRoot: string;
  generatedAt: string;
  base: SideInfo;
  target: SideInfo;
  /** Where the schema files came from */
  schemaFrom: SchemaFrom;
  diff: SchemaDiff;
  /** Tables for the ER diagram (all of them; the view picks which to show) */
  er: ErTable[];
  /**
   * Where each table, column, constraint, index and type is defined (target side, else base side), by
   * "schema.table", "schema.table.column", "schema.table:constraint_or_index" and "schema.type"
   */
  locations: Record<string, SourceLocation>;
  /** Statements read but not compared (functions, views, grants, ...) with their counts on the target side */
  ignored: { statement: string; count: number }[];
  /** Files that could not be parsed (their tables are left out of the comparison) and other notes */
  warnings: string[];
}

/** Every database of the repository compared on both sides (a monorepo can have several) */
export interface DbShapeRun {
  repoRoot: string;
  generatedAt: string;
  targetLabel: string;
  baseLabel: string;
  databases: DbShapeResult[];
}
