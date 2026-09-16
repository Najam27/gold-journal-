import React, { createContext, useContext, useEffect } from "react";

/**
 * Gold Journal is a dark-only product.
 *
 * The premium terminal look (midnight canvas, tinted ambient fields, cyan live
 * data, violet intelligence) only reads correctly on the dark palette, so the
 * theme is fixed rather than switchable. Keeping the provider and the `useTheme`
 * hook means any component that asks for the theme still gets a usable answer,
 * and the `dark` class is applied before first paint (see the bootstrap script in
 * index.html) so nothing flashes a light frame.
 */
export type Theme = "dark";

interface ThemeContextType {
  theme: Theme;
  switchable: boolean;
}

const DARK_THEME: ThemeContextType = { theme: "dark", switchable: false };

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("dark");
    root.dataset.theme = "dark";
    root.style.colorScheme = "dark";
    // A theme chosen while the app was still switchable would otherwise win on
    // the next load. Dark is the only theme now, so the preference is dropped.
    try {
      localStorage.removeItem("theme");
    } catch {
      /* storage can be unavailable in private/locked-down contexts */
    }
  }, []);

  return <ThemeContext.Provider value={DARK_THEME}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}
