import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { st } from "./css";

export type Theme = "light" | "dark";
const KEY = "noux.theme";
const stored = (): Theme | null => { try { const v = localStorage.getItem(KEY); return v === "light" || v === "dark" ? v : null; } catch { return null; } };
const system = (): Theme => (typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

export type Mode = Theme | "system";
const Ctx = createContext<{ theme: Theme; mode: Mode; setMode: (m: Mode) => void; toggle: () => void } | null>(null);

/** Stored choice wins; otherwise follow the OS. The <html data-theme> attribute is set early by a script in index.html to avoid a flash. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => stored() ?? system());
  const [mode, setModeState] = useState<Mode>(() => stored() ?? "system");
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => { // follow the OS while the visitor hasn't chosen
    if (typeof matchMedia !== "function") return;
    const m = matchMedia("(prefers-color-scheme: dark)");
    const on = () => { if (!stored()) setTheme(m.matches ? "dark" : "light"); };
    m.addEventListener("change", on); return () => m.removeEventListener("change", on);
  }, []);
  const toggle = useCallback(() => setTheme((t) => { const n = t === "dark" ? "light" : "dark"; try { localStorage.setItem(KEY, n); } catch { /* storage may be blocked */ } setModeState(n); return n; }), []);
  const setMode = useCallback((m: Mode) => {
    try { if (m === "system") localStorage.removeItem(KEY); else localStorage.setItem(KEY, m); } catch { /* storage may be blocked */ }
    setModeState(m); setTheme(m === "system" ? system() : m);
  }, []);
  return <Ctx.Provider value={{ theme, mode, setMode, toggle }}>{children}</Ctx.Provider>;
}
export const useTheme = () => { const c = useContext(Ctx); if (!c) throw new Error("ThemeProvider missing"); return c; };

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const dark = theme === "dark";
  return (
    <button className="press gh" type="button" onClick={toggle} aria-label={dark ? "Switch to light mode" : "Switch to dark mode"} title={dark ? "Light mode" : "Dark mode"}
      style={st("width: 36px; height: 36px; flex: none; border: 0; background: transparent; border-radius: 8px; color: #111111; cursor: pointer; display: inline-flex; align-items: center; justify-content: center;")}>
      {dark
        ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
        : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>}
    </button>
  );
}
