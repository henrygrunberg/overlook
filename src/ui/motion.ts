// A behavior passed from script overrides the reduced-motion `scroll-behavior` rule in the CSS.
export function scrollBehavior(): ScrollBehavior {
  return matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}
