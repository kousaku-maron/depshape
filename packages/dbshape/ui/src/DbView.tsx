import { loadJSON, saveJSON, type AiPlaced, type CommentReport, type ModuleViewProps } from "@diffshape/ui";
import { useEffect, useRef, useState } from "react";
import type { DbShapeRun } from "../../src/model";
import { changeCount, schemaFromText } from "../../src/names";
import { DbPane } from "./DbPane";
import { REVIEW_RULES } from "./review";

/*
 * The DB module: one pane per database of the repository (a monorepo can have several), switched at
 * the start of the first row. Hidden panes stay mounted, so each keeps its selection and comments box.
 */

export function DbView({ data: run, active, onComments, ai, onAi }: ModuleViewProps<DbShapeRun>) {
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
      // one list: the path of each definition tells the databases apart
      prompt: () => {
        const lists = withOpen.map((d) => reports[d.database.id].prompt().trimEnd()).filter(Boolean);
        return lists.length ? `${lists.join("\n=====\n")}\n` : "";
      },
      // what changed in each database, then how to answer (a database without changes is left out)
      review: () => {
        const lists = dbs.map((d) => ({ d, text: reports[d.database.id]?.review?.() ?? "" })).filter((x) => x.text);
        if (lists.length === 0) return "";
        return [...lists.map(({ d, text }) => (multi ? `### DB: ${d.database.name}\n\n${text}` : text)), REVIEW_RULES].join("\n\n");
      },
    });
  }, [dbs, reports, multi, onComments]);

  // an AI review's comments: each pane keeps the ones for its database (told apart by the prefix of
  // the target); once every pane has, the module says how many were kept and how many fit none
  const prefix = (i: number) => (multi ? `${i + 1}/` : "");
  const [placed, setPlaced] = useState<Record<string, AiPlaced>>({});
  const placers = useRef(new Map<string, (p: AiPlaced) => void>());
  const placer = (id: string) => {
    let f = placers.current.get(id);
    if (!f) placers.current.set(id, (f = (p: AiPlaced) => setPlaced((prev) => ({ ...prev, [id]: p }))));
    return f;
  };
  const acked = useRef(0);
  useEffect(() => {
    if (!ai || acked.current === ai.seq || !dbs.every((d) => placed[d.database.id]?.seq === ai.seq)) return;
    acked.current = ai.seq;
    const kept = dbs.reduce((n, d) => n + placed[d.database.id].placed, 0);
    onAi({ seq: ai.seq, placed: kept, dropped: ai.items.filter((i) => i.module === "db").length - kept });
  }, [ai, dbs, placed, onAi]);

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
      {dbs.map((d, i) => (
        <div key={d.database.id} className="db-pane" hidden={d !== current}>
          <DbPane data={d} active={active && d === current} onComments={reporter(d.database.id)} ai={ai} aiPrefix={prefix(i)} onAi={placer(d.database.id)} switcher={switcher} />
        </div>
      ))}
    </>
  );
}
