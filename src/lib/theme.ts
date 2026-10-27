import type { Theme } from "./types";

// The saved theme lives in the database; this copy only lets the first paint
// use it before settings load (see main.tsx).
const KEY = "kbot.theme";

/** Switches the palette in index.css (`[data-theme="dark"]`). */
export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Storage can be unavailable; the theme still applies for this session.
  }
}

export function cachedTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}
