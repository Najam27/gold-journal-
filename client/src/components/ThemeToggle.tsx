import React from "react";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/contexts/ThemeContext";

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  if (!toggleTheme) return null;
  const next = theme === "dark" ? "light" : "dark";
  return <button className="theme-toggle" onClick={toggleTheme} title={`Switch to ${next} theme`} aria-label={`Switch to ${next} theme`}><Sun className={theme === "light" ? "active" : ""} size={15} /><Moon className={theme === "dark" ? "active" : ""} size={15} /></button>;
}
