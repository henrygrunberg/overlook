import "./styles.css";
import { showStartupError, startApp } from "./app";
import { warn } from "./log";
import { SettingsStore } from "./settings/settings-store";

/** Mirrors the setting for focus-step.ts, which runs before settings can be read. */
const FOCUS_STEP_ENABLED_KEY = "overlook:focus-search-on-open";
// The step navigation replaces this page within moments. If it is still here after this, the
// navigation was cancelled (Esc, Stop) and the page has to work after all.
const STEP_FALLBACK_MS = 1500;

function mirrorFocusSetting(enabled: boolean): void {
  try {
    localStorage.setItem(FOCUS_STEP_ENABLED_KEY, String(enabled));
  } catch (error: unknown) {
    warn("remember the cursor setting", error);
  }
}

async function main(): Promise<void> {
  const settings = await SettingsStore.load();
  // The defaults would overwrite a choice that is still in storage.
  if (!settings.loadFailed) mirrorFocusSetting(settings.current.focusSearchOnOpen);
  settings.subscribe((current) => {
    mirrorFocusSetting(current.focusSearchOnOpen);
  });
  await startApp(settings);
}

if (document.documentElement.dataset.focusStep === "leaving") {
  window.addEventListener("load", () => {
    window.setTimeout(() => {
      main().catch(showStartupError);
    }, STEP_FALLBACK_MS);
  });
} else {
  main().catch(showStartupError);
}
