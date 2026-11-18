import { loadPref as load, savePref as save } from "@diffshape/ui";

/** depshape's view preferences, per browser (not per repository) */
export const loadPref = <T extends string>(key: string, fallback: T) => load<T>("depshape", key, fallback);

export const savePref = (key: string, value: string) => save("depshape", key, value);
