import { dispositionFor, isRepeatClick, type Disposition } from "./navigation";
import { isPanelAction, type PanelAction } from "./panel";

export interface PanelEventActions {
  readonly open: (url: string, disposition: Disposition) => void;
  readonly runAction: (action: PanelAction, bookmarkId: string | undefined) => void;
  readonly moveFavourite: (id: string, ontoId: string) => void;
}

const closest = (event: Event, selector: string) =>
  event.target instanceof Element ? event.target.closest<HTMLElement>(selector) : null;
const linkUrl = (event: Event) => closest(event, "a")?.dataset.bookmarkUrl;
const favouriteCard = (event: Event) => closest(event, "[data-favourite-index]");

export function bindPanelEvents(panel: HTMLElement, actions: PanelEventActions): void {
  panel.addEventListener("click", (event) => {
    const button = closest(event, "button[data-action]");
    if (button) {
      const { action, bookmarkId } = button.dataset;
      if (isPanelAction(action)) actions.runAction(action, bookmarkId);
      return;
    }
    const url = linkUrl(event);
    if (!url) return;
    if (favouriteCard(event) || isRepeatClick(event)) {
      event.preventDefault();
      return;
    }
    if (event.button !== 0 || event.shiftKey || event.altKey) return;
    event.preventDefault();
    actions.open(url, dispositionFor(event));
  });
  panel.addEventListener("auxclick", (event) => {
    const url = linkUrl(event);
    if (!url || event.button !== 1) return;
    event.preventDefault();
    if (!favouriteCard(event) && !isRepeatClick(event)) actions.open(url, "background-tab");
  });
  bindFavouriteDrag(panel, actions.moveFavourite);
}

function bindFavouriteDrag(panel: HTMLElement, moveFavourite: PanelEventActions["moveFavourite"]) {
  // Tracked here, not read from the drop, so drops from other pages or apps are ignored. A re-render
  // replaces the cards and loses the dragged card's dragend, so a detached card means no drag.
  let dragged: HTMLElement | null = null;
  const draggedId = () => (dragged?.isConnected ? dragged.dataset.bookmarkId : undefined);

  panel.addEventListener("dragstart", (event) => {
    dragged = favouriteCard(event);
    if (!dragged || !event.dataTransfer) return;
    event.dataTransfer.effectAllowed = "move";
    dragged.classList.add("is-dragging");
  });
  panel.addEventListener("dragover", (event) => {
    if (draggedId() === undefined || !favouriteCard(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  });
  panel.addEventListener("drop", (event) => {
    const id = draggedId();
    const ontoId = favouriteCard(event)?.dataset.bookmarkId;
    if (id === undefined || ontoId === undefined) return;
    event.preventDefault();
    if (ontoId !== id) moveFavourite(id, ontoId);
    dragged = null;
  });
  panel.addEventListener("dragend", () => {
    dragged = null;
    panel.querySelector(".is-dragging")?.classList.remove("is-dragging");
  });
}
