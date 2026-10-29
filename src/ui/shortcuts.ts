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

export function bindShortcuts(page: Document, actions: ShortcutActions): void {
  page.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing || isTypingTarget(event.target)) return;
    if (page.querySelector("dialog[open]")) return;
    const withShortcutModifier = event.metaKey || event.ctrlKey;
    if (withShortcutModifier && event.key.toLowerCase() === "k") {
      event.preventDefault();
      actions.focusSearch();
    } else if (withShortcutModifier || event.altKey) {
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
