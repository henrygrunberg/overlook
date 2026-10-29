import { beforeEach, describe, expect, it, vi } from "vitest";
import { h } from "./dom";
import { bindPanelEvents } from "./panel-events";

function card(id: string, { favouriteIndex }: { favouriteIndex?: number } = {}): HTMLElement {
  return h(
    "div",
    {
      attributes: {
        "data-bookmark-id": id,
        ...(favouriteIndex === undefined ? {} : { "data-favourite-index": String(favouriteIndex) }),
      },
    },
    [
      h("a", {
        text: id,
        attributes: {
          href: `https://${id}.example.com/`,
          "data-bookmark-url": `https://${id}.example.com/`,
        },
      }),
      h("button", { attributes: { "data-action": "toggle-pin", "data-bookmark-id": id } }),
    ],
  );
}

const linkOf = (element: Element) => element.querySelector("a") ?? element;

function click(target: Element, init: MouseEventInit = {}, type = "click") {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function drag(type: string, target: Element) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const dataTransfer = { effectAllowed: "uninitialized", dropEffect: "none" };
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  target.dispatchEvent(event);
  return { event, dataTransfer };
}

describe("bindPanelEvents", () => {
  const open = vi.fn();
  const runAction = vi.fn();
  const moveFavourite = vi.fn();
  let panel: HTMLElement;

  beforeEach(() => {
    for (const handler of [open, runAction, moveFavourite]) handler.mockClear();
    panel = h("div");
    document.body.replaceChildren(panel);
    bindPanelEvents(panel, { open, runAction, moveFavourite });
  });

  describe("links", () => {
    beforeEach(() => {
      panel.append(card("acme"));
    });

    it("opens a clicked bookmark in this tab", () => {
      expect(click(linkOf(panel)).defaultPrevented).toBe(true);
      expect(open).toHaveBeenCalledWith("https://acme.example.com/", "current-tab");
    });

    it.each([{ metaKey: true }, { ctrlKey: true }])(
      "opens it in a background tab with %o",
      (init) => {
        click(linkOf(panel), init);
        expect(open).toHaveBeenCalledWith("https://acme.example.com/", "background-tab");
      },
    );

    it("opens it in a background tab on a middle click", () => {
      expect(click(linkOf(panel), { button: 1 }, "auxclick").defaultPrevented).toBe(true);
      expect(open).toHaveBeenCalledWith("https://acme.example.com/", "background-tab");
    });

    it.each([{ shiftKey: true }, { altKey: true }])(
      "leaves a click with %o to the browser",
      (init) => {
        expect(click(linkOf(panel), init).defaultPrevented).toBe(false);
        expect(open).not.toHaveBeenCalled();
      },
    );

    it("runs a card's action with its bookmark", () => {
      const button = panel.querySelector("button");
      if (!button) throw new Error("No action button");
      click(button);
      expect(runAction).toHaveBeenCalledWith("toggle-pin", "acme");
      expect(open).not.toHaveBeenCalled();
    });

    it("ignores a button with an unknown action", () => {
      const button = panel.querySelector("button");
      button?.setAttribute("data-action", "delete-everything");
      if (button) click(button);
      expect(runAction).not.toHaveBeenCalled();
    });
  });

  describe("favourites being edited", () => {
    let first: HTMLElement;
    let second: HTMLElement;

    beforeEach(() => {
      first = card("first", { favouriteIndex: 0 });
      second = card("second", { favouriteIndex: 1 });
      panel.append(first, second);
    });

    it("don't open on a click or a middle click", () => {
      expect(click(linkOf(first)).defaultPrevented).toBe(true);
      expect(click(linkOf(first), { button: 1 }, "auxclick").defaultPrevented).toBe(true);
      expect(open).not.toHaveBeenCalled();
    });

    it("move when one is dropped onto another", () => {
      const { dataTransfer } = drag("dragstart", first);
      expect(dataTransfer.effectAllowed).toBe("move");
      expect(first.classList.contains("is-dragging")).toBe(true);
      expect(drag("dragover", second).event.defaultPrevented).toBe(true);
      drag("drop", second);
      drag("dragend", first);

      expect(moveFavourite).toHaveBeenCalledWith("first", "second");
      expect(first.classList.contains("is-dragging")).toBe(false);
    });

    it("stay put when one is dropped onto itself", () => {
      drag("dragstart", first);
      expect(drag("drop", first).event.defaultPrevented).toBe(true);
      expect(moveFavourite).not.toHaveBeenCalled();
    });

    it("ignore drops that didn't start on a favourite here", () => {
      expect(drag("dragover", second).event.defaultPrevented).toBe(false);
      drag("drop", second);
      expect(moveFavourite).not.toHaveBeenCalled();
    });

    it("ignore a drop after a re-render replaced the dragged card", () => {
      drag("dragstart", first);
      const replacement = card("first", { favouriteIndex: 0 });
      first.replaceWith(replacement);

      expect(drag("dragover", second).event.defaultPrevented).toBe(false);
      drag("drop", second);
      expect(moveFavourite).not.toHaveBeenCalled();
    });
  });
});
