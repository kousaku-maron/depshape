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

export interface SideInfo {
  label: string;
  files: string[];
}

export interface DbShapeResult {
  repoRoot: string;
  generatedAt: string;
  base: SideInfo;
  target: SideInfo;
  /** Where the schema files came from */
  schemaFrom: { kind: "atlas"; configs: string[] } | { kind: "option"; patterns: string[] };
  diff: SchemaDiff;
  /** Statements read but not compared (functions, views, grants, ...) with their counts on the target side */
  ignored: { statement: string; count: number }[];
  /** Files that could not be parsed (their tables are left out of the comparison) and other notes */
  warnings: string[];
}
