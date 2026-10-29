import type { BackgroundChoice } from "../settings/settings";
import { warn } from "../log";
import { h } from "../ui/dom";
import { currentFrame, loadDynamicWallpaper } from "../wallpaper/dynamic-wallpaper";
import { readCustomBackground } from "./custom-background";
import { DEFAULT_PHOTO, photoSrc } from "./photos";

const DYNAMIC_UPDATE_MS = 60_000;

export class BackgroundView {
  private readonly layers: readonly [HTMLImageElement, HTMLImageElement];
  private visibleLayer: 0 | 1 = 0;
  private requestedSrc: string | null = null;
  private shownSrc: string | null = null;
  private objectUrl: string | null = null;
  private dynamicTimer: number | undefined;
  private choice: BackgroundChoice = { kind: "auto" };
  /** Bumped on every apply(), so a slower earlier call can't start a stale timer or image. */
  private generation = 0;

  constructor(private readonly root: HTMLElement) {
    this.layers = [
      h("img", { className: "wallpaper__frame", attributes: { alt: "" } }),
      h("img", { className: "wallpaper__frame", attributes: { alt: "" } }),
    ];
    root.prepend(...this.layers);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && this.dynamicTimer !== undefined) {
        void this.apply(this.choice);
      }
    });
  }

  async apply(choice: BackgroundChoice): Promise<void> {
    const generation = ++this.generation;
    this.choice = choice;
    window.clearInterval(this.dynamicTimer);
    this.dynamicTimer = undefined;

    if (choice.kind === "auto" || choice.kind === "dynamic") {
      const wallpaper = await loadDynamicWallpaper();
      if (generation !== this.generation) return;
      if (wallpaper) {
        const { frame, src } = currentFrame(wallpaper);
        this.root.dataset.frame = String(frame);
        // A hidden tab skips its updates; visibilitychange catches up when it is shown again.
        this.dynamicTimer = window.setInterval(() => {
          if (!document.hidden) void this.apply(this.choice);
        }, DYNAMIC_UPDATE_MS);
        if (await this.show(src, "dynamic")) {
          this.releaseCustomImage(generation);
          return;
        }
        if (generation !== this.generation) return;
      }
    }
    delete this.root.dataset.frame;
    if (choice.kind === "custom") {
      const image = await readCustomBackground().catch(() => null);
      if (generation !== this.generation) return;
      if (image && (await this.showCustom(image))) return;
      if (generation !== this.generation) return;
    }
    const photo = choice.kind === "photo" ? choice.photo : DEFAULT_PHOTO;
    await this.show(photoSrc(photo), `photo:${photo}`);
    this.releaseCustomImage(generation);
  }

  private async showCustom(image: Blob): Promise<boolean> {
    const src = URL.createObjectURL(image);
    const shown = await this.show(src, "custom");
    if (!shown || this.requestedSrc !== src) {
      URL.revokeObjectURL(src);
      return shown;
    }
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = src;
    return true;
  }

  // Only the latest apply() may free the upload: an older one could free a newer upload's URL.
  private releaseCustomImage(generation: number): void {
    if (generation !== this.generation || this.objectUrl === null) return;
    URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }

  /** False only when the image can't be decoded; a superseded image counts as handled. */
  private async show(src: string, kind: string): Promise<boolean> {
    if (src === this.requestedSrc) return true;
    this.requestedSrc = src;
    const loader = new Image();
    loader.src = src;
    try {
      await loader.decode();
    } catch (error: unknown) {
      warn(`load the background ${src}`, error);
      if (this.requestedSrc === src) {
        // A fallback to the image still on screen must not decode it again and cross-fade it.
        this.requestedSrc = this.shownSrc;
        if (this.root.dataset.state !== "ready") this.root.dataset.state = "fallback";
      }
      return false;
    }
    if (this.requestedSrc !== src) return true;

    const visible = this.layers[this.visibleLayer];
    const next = this.visibleLayer === 0 ? 1 : 0;
    const hidden = this.layers[next];
    hidden.src = src;
    this.shownSrc = src;
    hidden.classList.add("is-visible");
    visible.classList.remove("is-visible");
    this.visibleLayer = next;
    this.root.dataset.background = kind;
    this.root.dataset.state = "ready";
    if (!this.root.classList.contains("is-animated")) {
      // Flush styles so the first, quick fade-in has started before the slow cross-fade applies.
      this.root.getBoundingClientRect();
      this.root.classList.add("is-animated");
    }
    return true;
  }
}
