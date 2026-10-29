export type Disposition = "current-tab" | "background-tab";

export function shortcutModifier(platform = navigator.platform): "⌘" | "Ctrl" {
  return /^(Mac|iPhone|iPad)/.test(platform) ? "⌘" : "Ctrl";
}

export function dispositionFor(event: MouseEvent | KeyboardEvent): Disposition {
  const middleClick = event instanceof MouseEvent && event.button === 1;
  return event.metaKey || event.ctrlKey || middleClick ? "background-tab" : "current-tab";
}

// chrome.tabs opens chrome://, brave:// and file:// bookmarks, which a plain link on an extension
// page can't. file:// also needs "Allow access to file URLs", on by default for unpacked extensions.
export async function openUrl(url: string, disposition: Disposition): Promise<void> {
  if (disposition === "background-tab") {
    await chrome.tabs.create({ url, active: false });
  } else {
    await chrome.tabs.update({ url });
  }
}

export async function searchWeb(text: string, disposition: Disposition): Promise<void> {
  await chrome.search.query({
    text,
    disposition: disposition === "background-tab" ? "NEW_TAB" : "CURRENT_TAB",
  });
}
