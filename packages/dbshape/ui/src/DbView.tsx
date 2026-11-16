import { loadJSON, saveJSON, type CommentReport, type ModuleViewProps } from "@diffshape/ui";
import { useEffect, useRef, useState } from "react";
import type { DbShapeRun } from "../../src/model";
import { changeCount, schemaFromText } from "../../src/names";
import { DbPane } from "./DbPane";

/*
 * The DB module: one pane per database of the repository (a monorepo can have several), switched at
 * the start of the first row. Hidden panes stay mounted, so each keeps its selection and comments box.
 */

export function DbView({ data: run, active, onComments }: ModuleViewProps<DbShapeRun>) {
  const dbs = run.databases;
  const multi = dbs.length > 1;
  const key = `dbshape.database:${run.repoRoot}`;
  const [selected, setSelected] = useState<string | undefined>(() => {
    const saved = loadJSON<string | null>(key, null);
    if (saved && dbs.some((d) => d.database.id === saved)) return saved;
    // the database with the most changes first
    return [...dbs].sort((a, b) => changeCount(b) - changeCount(a))[0]?.database.id;
  });
  const current = dbs.find((d) => d.database.id === selected) ?? dbs[0];
  const select = (id: string) => {
    setSelected(id);
    saveJSON(key, id);
  };

  // each pane reports its comments; the module reports them together, under each database's name
  const [reports, setReports] = useState<Record<string, CommentReport>>({});
  const reporters = useRef(new Map<string, (r: CommentReport) => void>());
  const reporter = (id: string) => {
    let f = reporters.current.get(id);
    if (!f) reporters.current.set(id, (f = (r: CommentReport) => setReports((prev) => ({ ...prev, [id]: r }))));
    return f;
  };
  useEffect(() => {
    const withOpen = dbs.filter((d) => (reports[d.database.id]?.open ?? 0) > 0);
    onComments({
      open: withOpen.reduce((n, d) => n + reports[d.database.id].open, 0),
      prompt: () =>
        withOpen
          .map((d) => {
            const text = reports[d.database.id].prompt().trimEnd();
            return multi ? `### DB: ${d.database.name}\n\n${text}` : text;
          })
          .join("\n\n"),
    });
  }, [dbs, reports, multi, onComments]);

  if (!current) return <div className="fatal muted">スキーマの SQL ファイルがありません</div>;

  const switcher = multi ? (
    <div className="db-switch" role="tablist" aria-label="データベース">
      {dbs.map((d) => {
        const n = changeCount(d);
        const on = d === current;
        return (
          <button
            key={d.database.id}
            role="tab"
            aria-selected={on}
            className={`db-tab ${on ? "on" : ""} ${n === 0 ? "quiet" : ""}`}
            onClick={() => select(d.database.id)}
            title={`${schemaFromText(d.schemaFrom)}\n変更 ${n}`}
          >
            <span className="db-name">{d.database.name}</span>
            <span className="db-count">{n}</span>
          </button>
        );
      })}
    </div>
  ) : undefined;

  return (
    <>
      {dbs.map((d) => (
        <div key={d.database.id} className="db-pane" hidden={d !== current}>
          <DbPane data={d} active={active && d === current} onComments={reporter(d.database.id)} switcher={switcher} />
        </div>
      ))}
    </>
  );
}
