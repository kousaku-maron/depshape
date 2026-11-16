// The screen side of the dbshape module.
import { DatabaseIcon, type ShapeModule } from "@diffshape/ui";
import type { DbShapeResult } from "../../src/model";
import { DbView } from "./DbView";
import "./styles.css";

export const dbModule: ShapeModule<DbShapeResult> = {
  id: "db",
  title: "DB",
  description: "DB スキーマ（dbshape）: テーブル・カラム・制約・CHECK の値の変化",
  icon: DatabaseIcon,
  View: DbView,
  badge: (d) => d.diff.tables.length + d.diff.values.length || undefined,
};
