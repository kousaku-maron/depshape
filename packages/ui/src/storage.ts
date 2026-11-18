import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

/*
 * Small wrappers around localStorage. Storage can be missing or full (private windows, blocked site
 * data), so reads fall back and writes are best effort.
 */

export function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function saveJSON(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

export function removeKey(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** Removes every key that starts with `prefix` (dbshape keeps one per database) */
export function removeKeysWithPrefix(prefix: string) {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(prefix)) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

/** A set of strings kept in localStorage under `key` (as an array) */
export function useStoredSet(key: string): [Set<string>, Dispatch<SetStateAction<Set<string>>>] {
  const [value, setValue] = useState<Set<string>>(() => {
    const v = loadJSON<unknown>(key, []);
    return new Set(Array.isArray(v) ? (v as string[]) : []);
  });
  useEffect(() => saveJSON(key, [...value]), [key, value]);
  return [value, setValue];
}

/**
 * A view preference of one module, per browser (not per repository): which view, which toggle.
 * Saved as "<module>.<key>", e.g. "depshape.mapMode".
 */
export function loadPref<T extends string>(module: string, key: string, fallback: T): T {
  try {
    return (localStorage.getItem(`${module}.${key}`) as T | null) ?? fallback;
  } catch {
    return fallback;
  }
}

export function savePref(module: string, key: string, value: string) {
  try {
    localStorage.setItem(`${module}.${key}`, value);
  } catch {
    /* ignore */
  }
}
