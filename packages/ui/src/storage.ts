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

/** A set of strings kept in localStorage under `key` (as an array) */
export function useStoredSet(key: string): [Set<string>, Dispatch<SetStateAction<Set<string>>>] {
  const [value, setValue] = useState<Set<string>>(() => {
    const v = loadJSON<unknown>(key, []);
    return new Set(Array.isArray(v) ? (v as string[]) : []);
  });
  useEffect(() => saveJSON(key, [...value]), [key, value]);
  return [value, setValue];
}
