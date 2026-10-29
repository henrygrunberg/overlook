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
  const page = await chrome.tabs.getCurrent();
  if (disposition === "background-tab") {
    await openInBackground(url, page);
  } else if (page?.id === undefined) {
    await chrome.tabs.update({ url });
  } else {
    // Without an id Chrome navigates the window's active tab, which may no longer be this one.
    await chrome.tabs.update(page.id, { url });
  }
}

// Where a Ctrl-click puts it: after this tab and the ones it opened before, in this tab's group.
async function openInBackground(url: string, page: chrome.tabs.Tab | undefined): Promise<void> {
  if (page?.id === undefined) {
    await chrome.tabs.create({ url, active: false });
    return;
  }
  const opener = page.id;
  const lastOpened = (await chrome.tabs.query({ windowId: page.windowId }))
    .filter((tab) => tab.openerTabId === opener && tab.index > page.index)
    .reduce((last, tab) => Math.max(last, tab.index), page.index);
  const tab = await chrome.tabs.create({
    url,
    active: false,
    index: lastOpened + 1,
    openerTabId: opener,
  });
  if (page.groupId !== -1 && tab.id !== undefined) {
    await chrome.tabs.group({ groupId: page.groupId, tabIds: tab.id });
  }
}

export async function searchWeb(text: string, disposition: Disposition): Promise<void> {
  await chrome.search.query({
    text,
    disposition: disposition === "background-tab" ? "NEW_TAB" : "CURRENT_TAB",
  });
}
