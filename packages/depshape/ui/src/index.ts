// The screen side of the depshape module.
import { GraphIcon, type ShapeModule } from "@diffshape/ui";
import type { DiffGraph } from "../../src/types";
import { DepView } from "./DepView";
import "./styles.css";

export const depModule: ShapeModule<DiffGraph> = {
  id: "dep",
  title: "依存",
  description: "コードの依存関係（depshape）: フォルダ・ファイルの import の変化",
  icon: GraphIcon,
  View: DepView,
  badge: (g) => g.files.filter((f) => f.status !== "unchanged").length || undefined,
};
