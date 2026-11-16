// The screen side of the dbshape module.
import { DatabaseIcon, type ShapeModule } from "@diffshape/ui";
import type { DbShapeRun } from "../../src/model";
import { changeCount } from "../../src/names";
import { DbView } from "./DbView";
import "./styles.css";

export const dbModule: ShapeModule<DbShapeRun> = {
  id: "db",
  title: "DB",
  description: "DB スキーマ（dbshape）: テーブル・カラム・制約・CHECK の値の変化",
  icon: DatabaseIcon,
  View: DbView,
  badge: (run) => run.databases.reduce((n, d) => n + changeCount(d), 0) || undefined,
};
