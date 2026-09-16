import React from "react";

/**
 * Gold Journal ships a single (dark) theme, so there is nothing to switch.
 *
 * The shell renders this in the desktop page bar and in the mobile top bar to
 * keep those action rows layout-stable, and it deliberately renders nothing:
 * the midnight terminal palette, ambient fields and semantic accents only read
 * correctly on dark, so a light variant is not offered at all.
 */
export function ThemeToggle() {
  return null;
}
