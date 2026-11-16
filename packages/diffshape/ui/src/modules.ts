import { dbModule } from "@diffshape/dbshape/ui";
import { depModule } from "@diffshape/depshape/ui";
import type { ShapeModule } from "@diffshape/ui";

/** Every module the shell knows, in rail order. The server says which ones this run uses. */
export const MODULES: ShapeModule[] = [depModule, dbModule];
