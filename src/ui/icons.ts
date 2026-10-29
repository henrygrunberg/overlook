const SVG_NS = "http://www.w3.org/2000/svg";

const ICONS = {
  search: ["M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14z", "m20 20-3.5-3.5"],
  home: ["M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5h-5v5H5a1 1 0 0 1-1-1z"],
  close: ["M6 6l12 12M18 6 6 18"],
  star: ["M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"],
  "chevron-left": ["m15 6-6 6 6 6"],
  "chevron-right": ["m9 6 6 6-6 6"],
  "chevron-down": ["m6 9 6 6 6-6"],
  settings: [
    "M4 7h9M19 7h1M4 17h3M13 17h7",
    "M16 4.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 0 0 0-5z",
    "M10 14.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 0 0 0-5z",
  ],
  globe: [
    "M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18z",
    "M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z",
  ],
  folder: [
    "M2.5 6.5A1.8 1.8 0 0 1 4.3 4.7h5l2 2h8.4a1.8 1.8 0 0 1 1.8 1.8V18a1.8 1.8 0 0 1-1.8 1.8H4.3A1.8 1.8 0 0 1 2.5 18z",
    "M2.5 9.6h19V18a1.8 1.8 0 0 1-1.8 1.8H4.3A1.8 1.8 0 0 1 2.5 18z",
  ],
} as const satisfies Record<string, readonly string[]>;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, className = ""): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", `icon icon--${name} ${className}`.trim());
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
