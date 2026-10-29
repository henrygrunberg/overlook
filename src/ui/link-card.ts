import type { Bookmark } from "../bookmarks/library";
import type { IconSource, IconState } from "../favicons/icon-library";
import { iconOrigin } from "../favicons/icon-store";
import type { LabelRule } from "../settings/settings";
import { h } from "./dom";
import { faviconUrl, isDefaultFavicon } from "./favicon";
import { icon, type IconName } from "./icons";
import type { PanelAction } from "./panel";

export type CardDetail = "host" | "path";

export interface BookmarkDecor {
  readonly color: string;
  readonly labels: readonly LabelRule[];
  readonly icons: IconSource;
  readonly pinned: boolean;
  readonly canPin: boolean;
}

export function labelChips(labels: readonly LabelRule[]): HTMLElement | null {
  if (labels.length === 0) return null;
  return h(
    "span",
    { className: "chips" },
    labels.map((label) => h("span", { className: `chip chip--${label.color}`, text: label.text })),
  );
}

const graphemes = new Intl.Segmenter();

// A whole grapheme, so a title that starts with an emoji or a flag keeps it intact.
function monogram(title: string): string {
  const [first] = graphemes.segment(title.trim());
  return first?.segment.toLocaleUpperCase() ?? "•";
}

function showMonogram(tile: HTMLElement, bookmark: Bookmark): void {
  tile.classList.remove("favicon-tile--full-bleed");
  tile.classList.add("favicon-tile--monogram");
  tile.replaceChildren(monogram(bookmark.title));
}

function showIcon(tile: HTMLElement, bookmark: Bookmark, state: IconState): void {
  if (state.kind === "none") {
    showMonogram(tile, bookmark);
    return;
  }
  const image = h("img", { attributes: { alt: "", decoding: "async", loading: "lazy" } });
  tile.classList.remove("favicon-tile--monogram");
  tile.classList.toggle("favicon-tile--full-bleed", state.kind === "image" && state.fullBleed);
  if (state.kind === "image") {
    image.src = state.src;
  } else {
    // Borrow the browser's favicon until the sharp icon is cached, unless it's the generic globe.
    image.src = faviconUrl(bookmark.url);
    image.addEventListener("load", () => {
      void isDefaultFavicon(image).then((isDefault) => {
        if (isDefault && image.isConnected) showMonogram(tile, bookmark);
      });
    });
  }
  image.addEventListener("error", () => {
    showMonogram(tile, bookmark);
  });
  tile.replaceChildren(image);
}

export function faviconTile(bookmark: Bookmark, decor: BookmarkDecor, small = false): HTMLElement {
  const tile = h("span", {
    className: small ? "favicon-tile favicon-tile--small" : "favicon-tile",
    attributes: {
      "aria-hidden": "true",
      "data-bookmark-id": bookmark.id,
      "data-icon-origin": iconOrigin(bookmark.url) ?? "",
    },
  });
  tile.style.setProperty("--folder-color", decor.color);
  showIcon(tile, bookmark, decor.icons.iconFor(bookmark.url));
  return tile;
}

export function refreshIconTiles(
  root: ParentNode,
  origin: string,
  icons: IconSource,
  bookmarkFor: (id: string) => Bookmark | undefined,
): void {
  const tiles = root.querySelectorAll<HTMLElement>(`[data-icon-origin="${CSS.escape(origin)}"]`);
  for (const tile of tiles) {
    const bookmark = bookmarkFor(tile.dataset.bookmarkId ?? "");
    if (bookmark) showIcon(tile, bookmark, icons.iconFor(bookmark.url));
  }
}

export interface EditPosition {
  readonly index: number;
  readonly count: number;
}

function actionButton(
  action: PanelAction,
  bookmark: Bookmark,
  label: string,
  iconName: IconName,
  disabled = false,
): HTMLButtonElement {
  return h(
    "button",
    {
      className: `card-action card-action--${action}`,
      attributes: {
        type: "button",
        "data-action": action,
        "data-bookmark-id": bookmark.id,
        "aria-label": label,
        title: label,
        ...(disabled ? { disabled: "" } : {}),
      },
    },
    [icon(iconName)],
  );
}

/** The buttons sit beside the link because links can't contain buttons. */
export function linkCard(
  bookmark: Bookmark,
  detail: CardDetail,
  decor: BookmarkDecor,
  editing?: EditPosition,
): HTMLElement {
  const subtitle = h("span", {
    className: "link-card__detail",
    text: detail === "path" ? bookmark.path.join(" › ") : bookmark.host,
  });
  const link = h(
    "a",
    {
      className: "link-card",
      attributes: {
        href: bookmark.url,
        "data-bookmark-url": bookmark.url,
        title: `${bookmark.title}\n${bookmark.url}`,
        ...(editing ? { tabindex: "-1", draggable: "false" } : {}),
      },
    },
    [
      faviconTile(bookmark, decor),
      h("span", { className: "link-card__text" }, [
        h("span", { className: "link-card__title", text: bookmark.title }),
        h("span", { className: "link-card__meta" }, [subtitle, labelChips(decor.labels)]),
      ]),
    ],
  );

  const actions = editing
    ? [
        actionButton(
          "move-earlier",
          bookmark,
          `Move ${bookmark.title} earlier`,
          "chevron-left",
          editing.index === 0,
        ),
        actionButton(
          "move-later",
          bookmark,
          `Move ${bookmark.title} later`,
          "chevron-right",
          editing.index === editing.count - 1,
        ),
        actionButton("unpin", bookmark, `Unpin ${bookmark.title}`, "close"),
      ]
    : [
        actionButton(
          "toggle-pin",
          bookmark,
          decor.pinned
            ? `Unpin ${bookmark.title} from Home`
            : decor.canPin
              ? `Pin ${bookmark.title} to Home`
              : `Home is full: unpin a favourite to pin ${bookmark.title}`,
          "star",
          !decor.pinned && !decor.canPin,
        ),
      ];

  return h(
    "div",
    {
      className: `link-card-wrap${decor.pinned ? " is-pinned" : ""}`,
      attributes: {
        "data-bookmark-id": bookmark.id,
        ...(editing ? { draggable: "true", "data-favourite-index": String(editing.index) } : {}),
      },
    },
    [link, h("span", { className: "card-actions" }, actions)],
  );
}
