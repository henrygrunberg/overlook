import { beforeEach, describe, expect, it, vi } from "vitest";
import { bindShortcuts } from "./shortcuts";

describe("bindShortcuts", () => {
  const focusSearch = vi.fn();
  const openSettings = vi.fn();
  let page: Document;

  beforeEach(() => {
    focusSearch.mockClear();
    openSettings.mockClear();
    page = document.implementation.createHTMLDocument();
    bindShortcuts(page, { focusSearch, openSettings });
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
