import type { Folder } from "../bookmarks/library";
import { h } from "./dom";
import type { FolderColors } from "./folder-colors";
import { icon } from "./icons";
import { scrollBehavior } from "./motion";
import { countOf } from "./text";

export interface SidebarProps {
  readonly folders: readonly Folder[];
  readonly selectedFolderId: string | null;
  readonly colorOf: FolderColors;
  readonly onSelect: (folderId: string | null) => void;
}

const HOME_KEY = "home";
const MORE_KEY = "more";
const overflowObservers = new WeakMap<HTMLElement, ResizeObserver>();

function sidebarButton(
  key: string,
  label: string,
  selected: boolean,
  onClick: () => void,
  leading: Element,
  count?: number,
): HTMLButtonElement {
  const button = h(
    "button",
    {
      className: "sidebar__item",
      attributes: {
        type: "button",
        "data-key": key,
        title: label,
        ...(selected ? { "aria-current": "page" } : {}),
      },
    },
    [
      leading,
      h("span", { className: "sidebar__label", text: label }),
      count !== undefined && h("span", { className: "sidebar__count", text: String(count) }),
    ],
  );
  button.addEventListener("click", onClick);
  return button;
}

export function renderSidebar(root: HTMLElement, props: SidebarProps): void {
  const focusedKey =
    document.activeElement instanceof HTMLElement && root.contains(document.activeElement)
      ? document.activeElement.dataset.key
      : undefined;

  const home = sidebarButton(
    HOME_KEY,
    "Home",
    props.selectedFolderId === null,
    () => {
      props.onSelect(null);
    },
    icon("home"),
  );
  const folders = props.folders.map((folder) => {
    const folderIcon = icon("folder");
    folderIcon.style.setProperty("--folder-color", props.colorOf(folder));
    return sidebarButton(
      folder.id,
      folder.title,
      folder.id === props.selectedFolderId,
      () => {
        props.onSelect(folder.id);
      },
      folderIcon,
      folder.totalBookmarks,
    );
  });
  const previousScroll = root.querySelector(".sidebar__folders")?.scrollTop ?? 0;
  const scroller = h("div", { className: "sidebar__folders" }, folders);
  const more = h("button", {
    className: "sidebar__more",
    attributes: { type: "button", "data-key": MORE_KEY },
  });
  root.replaceChildren(home, h("hr", { className: "divider" }), scroller, more);
  scroller.scrollTop = previousScroll;

  // Re-rendering replaces the buttons; keep keyboard focus where it was.
  if (focusedKey !== undefined) {
    const focused = [home, ...folders, more].find((button) => button.dataset.key === focusedKey);
    focused?.focus({ preventScroll: true });
  }

  const updateOverflow = () => {
    const bottom = scroller.scrollTop + scroller.clientHeight;
    const hiddenBelow = folders.filter(
      (button) => button.offsetTop + button.offsetHeight / 2 > bottom,
    ).length;
    scroller.classList.toggle("has-more-above", scroller.scrollTop > 1);
    scroller.classList.toggle("has-more-below", hiddenBelow > 0);
    // Hiding the focused pill would drop focus to <body>, so hand it to the last folder first.
    if (hiddenBelow === 0 && document.activeElement === more) {
      folders.at(-1)?.focus({ preventScroll: true });
    }
    more.hidden = hiddenBelow === 0;
    more.textContent = countOf(hiddenBelow, "more folder");
  };
  more.addEventListener("click", () => {
    scroller.scrollBy({ top: scroller.clientHeight * 0.8, behavior: scrollBehavior() });
  });
  scroller.addEventListener("scroll", updateOverflow, { passive: true });
  overflowObservers.get(root)?.disconnect();
  const observer = new ResizeObserver(updateOverflow);
  observer.observe(scroller);
  overflowObservers.set(root, observer);
  updateOverflow();
}
