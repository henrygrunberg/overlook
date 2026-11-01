import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const fromRoot = (path: string) => resolve(import.meta.dirname, path);

export default defineConfig({
  root: "src",
  base: "./",
  publicDir: fromRoot("public"),
  build: {
    outDir: fromRoot("dist"),
    emptyOutDir: true,
    target: "chrome137",
    modulePreload: { polyfill: false },
    // The CSP allows no data: images, so nothing may be inlined as one.
    assetsInlineLimit: 0,
    rolldownOptions: {
      input: {
        newtab: fromRoot("src/newtab.html"),
        background: fromRoot("src/service-worker.ts"),
        "focus-step": fromRoot("src/focus-step.ts"),
      },
      output: {
        // The manifest names the service worker and newtab.html the focus step (a plain script,
        // which Vite leaves alone), so their file names must not be hashed.
        entryFileNames: (chunk) =>
          chunk.name === "background" || chunk.name === "focus-step"
            ? `${chunk.name}.js`
            : "assets/[name]-[hash].js",
      },
    },
  },
  test: {
    root: ".",
    include: ["tests/unit/**/*.test.ts"],
    environment: "happy-dom",
    setupFiles: ["tests/unit/fixtures/web-locks.ts"],
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    coverage: {
      provider: "v8",
      reporter: ["text-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/wallpaper/timezone-coordinates.ts"],
      thresholds: {
        lines: 90,
        branches: 80,
        functions: 84,
        "src/{bookmarks,favicons,home,labels,search,settings,usage,wallpaper}/**": {
          perFile: true,
          lines: 70,
          branches: 75,
        },
      },
    },
  },
});
