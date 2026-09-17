import * as React from "react";

const MOBILE_BREAKPOINT = 768;

/** Below this the sidebar is an off-canvas drawer instead of a fixed rail. */
export const DRAWER_BREAKPOINT = 1024;

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(
    undefined
  );

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };
    mql.addEventListener("change", onChange);
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return !!isMobile;
}

/**
 * True while the shell is in drawer (off-canvas) mode.
 *
 * `AppSidebar` asserts the drawer's open geometry inline rather than trusting a
 * class-only rule: three stylesheets ship competing `.gj-sidebar` widths and a
 * collapsed rail preference (`gj:sidebar-rail`) is remembered across reloads, so
 * a drawer that resolves to 76px, or to `translateX(-104%)` behind a scrim with
 * the page scroll-locked, is indistinguishable from a frozen app. The inline
 * style cannot lose that contest, and the value is read synchronously so the
 * first paint already has the right geometry.
 */
export function useIsDrawerNav() {
  const query = `(max-width: ${DRAWER_BREAKPOINT - 1}px)`;
  const [isDrawer, setIsDrawer] = React.useState(() =>
    typeof window === "undefined" || typeof window.matchMedia !== "function"
      ? false
      : window.matchMedia(query).matches
  );

  React.useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent) => setIsDrawer(event.matches);
    mql.addEventListener("change", onChange);
    setIsDrawer(mql.matches);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return isDrawer;
}
