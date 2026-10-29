// Chromium gives a new tab's keyboard focus to the address bar and won't let the new-tab page take
// it, but a page the tab navigated to may, and going Back keeps it (with an empty address bar). So
// a fresh page steps forward to `?focus` and straight back. Not working: focus() alone, pushState,
// or navigating to chrome://newtab (refocuses the address bar). Runs first, as a plain <head>
// script, so main.ts knows to wait while the page steps away after load.

// Loaded as a classic script: it must stay import-free, and the IIFE keeps its names off window.
(() => {
  const FOCUS_PARAM = "focus";
  const RETURNING_KEY = "overlook:returning-with-focus";
  const ENABLED_KEY = "overlook:focus-search-on-open";

  function navigationType(): string | undefined {
    const [navigation] = performance.getEntriesByType("navigation");
    return navigation instanceof PerformanceNavigationTiming ? navigation.type : undefined;
  }

  function takeFocusStep(): boolean {
    if (new URLSearchParams(location.search).has(FOCUS_PARAM)) {
      if (history.length < 2) return false;
      sessionStorage.setItem(RETURNING_KEY, "1");
      history.back();
      return true;
    }
    const returning = sessionStorage.getItem(RETURNING_KEY) !== null;
    sessionStorage.removeItem(RETURNING_KEY);
    if (returning || navigationType() !== "navigate") return false;
    if (localStorage.getItem(ENABLED_KEY) === "false") return false;
    // Chromium turns a navigation started during load into a replace, leaving nothing to go Back to.
    window.addEventListener("load", () => {
      setTimeout(() => {
        location.assign(`?${FOCUS_PARAM}`);
      });
    });
    return true;
  }

  try {
    // main.ts reads this to stay out of the way while the page is leaving.
    if (takeFocusStep()) document.documentElement.dataset.focusStep = "leaving";
  } catch (error: unknown) {
    console.warn("Overlook: could not take focus from the address bar", error);
  }
})();
