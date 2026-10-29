import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindShortcuts } from "./shortcuts";

describe("bindShortcuts", () => {
  const focusSearch = vi.fn();
  const openSettings = vi.fn();
  let page: Document;

  function bindPage(): Document {
    const created = document.implementation.createHTMLDocument();
    bindShortcuts(created, { focusSearch, openSettings });
    return created;
  }

  beforeEach(() => {
    focusSearch.mockClear();
    openSettings.mockClear();
    page = bindPage();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = page) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  }

  it.each([
    ["k", { metaKey: true }],
    ["K", { ctrlKey: true }],
    ["/", {}],
  ])("focuses the search on %s %o and keeps the key from the browser", (key, init) => {
    expect(press(key, init).defaultPrevented).toBe(true);
    expect(focusSearch).toHaveBeenCalledOnce();
  });

  it("opens the settings on a comma", () => {
    expect(press(",").defaultPrevented).toBe(true);
    expect(openSettings).toHaveBeenCalledOnce();
  });

  it("lets a typed character reach the search field", () => {
    expect(press("g").defaultPrevented).toBe(false);
    expect(focusSearch).toHaveBeenCalledOnce();
  });

  it.each([
    [" ", {}],
    ["Enter", {}],
    ["g", { metaKey: true }],
    ["/", { altKey: true }],
    ["g", { isComposing: true }],
  ])("ignores %o %o", (key, init) => {
    press(key, init);
    expect(focusSearch).not.toHaveBeenCalled();
  });

  it("leaves keys alone while typing in a field", () => {
    const field = page.createElement("input");
    page.body.append(field);
    press("/", {}, field);
    expect(focusSearch).not.toHaveBeenCalled();
  });

  it("keeps Ctrl+K from the browser while typing in the search field", () => {
    const field = page.createElement("input");
    page.body.append(field);
    expect(press("k", { ctrlKey: true }, field).defaultPrevented).toBe(true);
    expect(focusSearch).toHaveBeenCalledOnce();
  });

  it("finds Ctrl+K by its key on a layout without Latin letters", () => {
    expect(press("л", { ctrlKey: true, code: "KeyK" }).defaultPrevented).toBe(true);
    expect(focusSearch).toHaveBeenCalledOnce();
  });

  it("goes by the letter on a Latin layout that types another one on the K key", () => {
    expect(press("t", { ctrlKey: true, code: "KeyK" }).defaultPrevented).toBe(false);
    expect(focusSearch).not.toHaveBeenCalled();
  });

  describe("on a Mac", () => {
    beforeEach(() => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
      page = bindPage();
    });

    it("lets a character typed with Option start a search", () => {
      press("ł", { altKey: true });
      expect(focusSearch).toHaveBeenCalledOnce();
    });

    it("leaves Ctrl+K in a field to the field", () => {
      const field = page.createElement("input");
      page.body.append(field);
      expect(press("k", { ctrlKey: true }, field).defaultPrevented).toBe(false);
      expect(focusSearch).not.toHaveBeenCalled();
    });
  });

  it("leaves keys alone while a dialog is open", () => {
    const dialog = page.createElement("dialog");
    dialog.setAttribute("open", "");
    page.body.append(dialog);
    press(",");
    expect(openSettings).not.toHaveBeenCalled();
  });

  it("leaves keys another handler already took", () => {
    page.addEventListener(
      "keydown",
      (event) => {
        event.preventDefault();
      },
      { capture: true },
    );
    press("/");
    expect(focusSearch).not.toHaveBeenCalled();
  });
});
