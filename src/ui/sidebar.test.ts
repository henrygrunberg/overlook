import { afterEach, describe, expect, it, vi } from "vitest";
import { sampleLibrary } from "../test/sample-library";
import { renderSidebar, type SidebarProps } from "./sidebar";

const props: SidebarProps = {
  folders: sampleLibrary.topFolders,
  selectedFolderId: null,
  colorOf: () => "#0a84ff",
  onSelect: () => undefined,
};

function mountSidebar() {
  const root = document.createElement("nav");
  document.body.replaceChildren(root);
  renderSidebar(root, props);
  return root;
}

const prefersReducedMotion = (reduce: boolean) => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduce && query === "(prefers-reduced-motion: reduce)",
  }));
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("renderSidebar", () => {
  it("gives every folder a tooltip with its full name", () => {
    const root = mountSidebar();
    const titles = [...root.querySelectorAll(".sidebar__item")].map((item) =>
      item.getAttribute("title"),
    );
    expect(titles).toEqual(["Home", ...sampleLibrary.topFolders.map((folder) => folder.title)]);
  });

  it("moves focus to the last folder when the focused 'more folders' pill hides", () => {
    const root = mountSidebar();
    const more = () => root.querySelector<HTMLButtonElement>(".sidebar__more");
    const lastFolder = () => [...root.querySelectorAll(".sidebar__item")].at(-1);
    const showAndFocusMore = () => {
      const pill = more();
      if (!pill) throw new Error("No more-folders pill");
      pill.hidden = false;
      pill.focus();
    };

    showAndFocusMore();
    root.querySelector(".sidebar__folders")?.dispatchEvent(new Event("scroll"));
    expect(more()?.hidden).toBe(true);
    expect(document.activeElement).toBe(lastFolder());

    showAndFocusMore();
    renderSidebar(root, props);
    expect(document.activeElement).toBe(lastFolder());
  });

  it.each([
    [false, "smooth"],
    [true, "auto"],
  ])("scrolls to more folders, reduced motion %s: %s", (reduce, behavior) => {
    prefersReducedMotion(reduce);
    const scrollBy = vi
      .spyOn(HTMLElement.prototype, "scrollBy")
      .mockImplementation(() => undefined);
    mountSidebar().querySelector<HTMLButtonElement>(".sidebar__more")?.click();
    expect(scrollBy).toHaveBeenCalledWith(expect.objectContaining({ behavior }));
  });
});
