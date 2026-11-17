import type { ChangeStats } from "@diffshape/ui";

/** The tooltip of a dependency count: + / − are imports that appeared / disappeared */
export const DEP_TITLE = (s: ChangeStats) => `import が ${s.added} 増え、${s.removed} 減った`;
