export type Child = Node | string | false | null | undefined;

export interface ElementOptions {
  readonly className?: string;
  readonly text?: string;
  readonly attributes?: Readonly<Record<string, string>>;
}

/** Builds an element without ever parsing HTML, so bookmark titles can't inject markup. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  children: readonly Child[] = [],
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (options.className) element.className = options.className;
  if (options.text !== undefined) element.textContent = options.text;
  for (const [name, value] of Object.entries(options.attributes ?? {})) {
    element.setAttribute(name, value);
  }
  element.append(...children.filter((child): child is Node | string => Boolean(child)));
  return element;
}

/** Like replaceChildren, but leaves the children it keeps in place, so focus inside them stays. */
export function reconcileChildren(parent: Element, children: readonly Element[]): void {
  const wanted = new Set(children);
  for (const child of [...parent.children]) if (!wanted.has(child)) child.remove();
  children.forEach((child, index) => {
    const current = parent.children[index];
    if (current !== child) parent.insertBefore(child, current ?? null);
  });
}
