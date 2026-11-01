import { shortcutModifier } from "./navigation";
import { focusPanelTitle } from "./panel";

export interface ShortcutActions {
  readonly focusSearch: () => void;
  readonly openSettings: () => void;
}

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

// A Latin layout's K is the letter it types; other layouts (Cyrillic, Greek…) type their own.
function isKeyK(event: KeyboardEvent): boolean {
  return /^[a-z]$/i.test(event.key) ? event.key.toLowerCase() === "k" : event.code === "KeyK";
}

export function bindShortcuts(page: Document, actions: ShortcutActions): void {
  // Following the link's #panel would put that in the address bar and in the tab's history.
  page.addEventListener("click", (event) => {
    if (!(event.target instanceof Element) || !event.target.closest(".skip-link")) return;
    event.preventDefault();
    focusPanelTitle(page);
  });
  const isMac = shortcutModifier() === "⌘";
  page.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing) return;
    if (page.querySelector("dialog[open]")) return;
    const typing = isTypingTarget(event.target);
    const withShortcutModifier = event.metaKey || event.ctrlKey;
    // In a field only Ctrl+K off the Mac, which the browser would take to its address bar; a
    // Mac's Ctrl+K there deletes to the end of the line.
    if (withShortcutModifier && isKeyK(event) && (!typing || (event.ctrlKey && !isMac))) {
      event.preventDefault();
      actions.focusSearch();
    } else if (typing || withShortcutModifier || (event.altKey && !isMac)) {
      // A Mac types characters with Option (ł, @), so those still start a search.
      return;
    } else if (event.key === "/") {
      event.preventDefault();
      actions.focusSearch();
    } else if (event.key === ",") {
      event.preventDefault();
      actions.openSettings();
    } else if (event.key.length === 1 && event.key !== " ") {
      // Focusing during keydown lets the browser type this very key into the search field.
      actions.focusSearch();
    }
  });
}
