export const THEMES = ["paper", "sepia", "night"] as const;

export type Theme = (typeof THEMES)[number];

export const THEME_KEY = "md-file-reader-theme";
export const VIEW_KEY = "md-file-reader-view";

export function isTheme(value: string | null): value is Theme {
  return THEMES.includes(value as Theme);
}

export function readStoredTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (isTheme(saved)) {
      return saved;
    }
  } catch {
    // ignore
  }
  return "paper";
}

export function applyThemeToDocument(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}
