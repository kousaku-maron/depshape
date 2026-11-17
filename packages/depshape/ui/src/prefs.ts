/** Per-browser view preferences (not per repository) */

export function loadPref<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(`depshape.${key}`) as T | null) ?? fallback;
  } catch {
    return fallback;
  }
}

export function savePref(key: string, value: string) {
  try {
    localStorage.setItem(`depshape.${key}`, value);
  } catch {
    /* ignore */
  }
}
