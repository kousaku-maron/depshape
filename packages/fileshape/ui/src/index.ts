// The screen side of the fileshape module.
import { FileIcon, type ShapeModule } from "@diffshape/ui";
import type { FileShapeRun } from "../../src/types";
import { clearComments } from "./comments";
import { FileView } from "./FileView";
import { clearReviewed, reviewScope } from "./reviewed";
import "./styles.css";

export const fileModule: ShapeModule<FileShapeRun> = {
  id: "file",
  title: "ファイル",
  description: "ファイルの差分（fileshape）: 変更された各ファイルの行の差分",
  icon: FileIcon,
  View: FileView,
  badge: (r) => r.files.length || undefined,
  clearReview: (c) => {
    clearComments(reviewScope(c));
    clearReviewed(reviewScope(c));
  },
};
