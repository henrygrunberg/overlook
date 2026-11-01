import {
  LABEL_COLORS,
  MAX_HOST_PATTERNS,
  MAX_LABEL_LENGTH,
  MAX_LABELS,
  parseHostPatterns,
  type LabelColor,
  type LabelRule,
} from "../settings/settings";
import { h, reconcileChildren } from "./dom";
import { icon } from "./icons";
import { chipClass, labelChip } from "./link-card";
import { countOf } from "./text";

const COLOUR_NAMES: Record<LabelColor, string> = {
  green: "Green",
  blue: "Blue",
  orange: "Orange",
  purple: "Purple",
  red: "Red",
  gray: "Grey",
};

const addressCount = (count: number) => countOf(count, "address", "addresses");

export function labelSummary(label: LabelRule): string {
  const addresses = label.hosts.length === 0 ? "" : addressCount(label.hosts.length);
  if (label.privateNetwork)
    return addresses ? `Private networks + ${addresses}` : "Private networks";
  return addresses || "No addresses yet";
}

type LabelEdit = (changes: Partial<LabelRule>) => void;

const hostsHeading = (label: LabelRule) => `Addresses tagged ${label.text}`;
const LIMIT_HINT_ID = "label-limit-hint";

export function addHosts(hosts: readonly string[], text: string): string[] {
  const merged = [...new Set([...hosts, ...parseHostPatterns(text)])];
  return merged.slice(0, MAX_HOST_PATTERNS);
}

interface Row {
  readonly label: LabelRule;
  readonly isOpen: boolean;
  readonly element: HTMLElement;
}

// Identifies a control across a row's rebuild; the Edit button's name changes with the label's.
const controlKey = (control: Element) =>
  control.matches(".label-row__toggle")
    ? "toggle"
    : `${control.className} ${control.getAttribute("aria-label") ?? ""}`;

export class LabelEditor {
  readonly element: HTMLElement;
  private readonly list = h("div", { className: "label-list" });
  private readonly addButton = h("button", {
    className: "settings__action",
    text: "New label",
    attributes: { type: "button" },
  });
  private readonly limitHint = h("p", {
    className: "label-editor__limit",
    text: `That's the limit of ${MAX_LABELS} labels.`,
    attributes: { id: LIMIT_HINT_ID },
  });
  private current: LabelRule[];
  private rows = new Map<string, Row>();
  private openId: string | null = null;

  constructor(
    initial: readonly LabelRule[],
    private readonly onChange: (labels: readonly LabelRule[]) => void,
  ) {
    this.current = [...initial];
    this.addButton.addEventListener("click", () => {
      const label: LabelRule = {
        id: crypto.randomUUID(),
        text: "Label",
        color: LABEL_COLORS[this.current.length % LABEL_COLORS.length] ?? "gray",
        privateNetwork: false,
        hosts: [],
      };
      this.current.push(label);
      this.onChange(this.current);
      this.openId = label.id;
      this.render();
      this.list.querySelector<HTMLInputElement>(".label-editor__name")?.select();
    });
    this.element = h("div", { className: "label-editor" }, [
      this.list,
      this.addButton,
      this.limitHint,
    ]);
    this.render();
  }

  get labels(): readonly LabelRule[] {
    return this.current;
  }

  /** Rebuilds only the rows whose label changed, keeping focus and half-typed text in them. */
  show(labels: readonly LabelRule[]): void {
    this.current = [...labels];
    this.render();
  }

  private update(id: string, changes: Partial<LabelRule>): LabelRule | undefined {
    const index = this.current.findIndex((label) => label.id === id);
    const current = this.current[index];
    const row = this.rows.get(id);
    if (!current || !row) return undefined;
    const next = { ...current, ...changes };
    this.current[index] = next;
    this.rows.set(id, { ...row, label: next });
    this.onChange(this.current);
    return next;
  }

  private render(): void {
    const focused = document.activeElement;
    const previous = this.rows;
    const previousIds = [...previous.keys()];
    const focusedIndex = previousIds.findIndex((id) => previous.get(id)?.element.contains(focused));
    const focusedRowId = previousIds[focusedIndex];
    // Chromium blurs a field as it is removed, and the address field's blur commits and clears it.
    const typed =
      focused instanceof HTMLInputElement
        ? { value: focused.value, start: focused.selectionStart, end: focused.selectionEnd }
        : undefined;
    this.rows = new Map(
      this.current.map((label) => {
        const isOpen = this.openId === label.id;
        const kept = previous.get(label.id);
        const row =
          kept?.label === label && kept.isOpen === isOpen
            ? kept
            : { label, isOpen, element: this.row(label, isOpen) };
        return [label.id, row];
      }),
    );
    reconcileChildren(
      this.list,
      [...this.rows.values()].map((row) => row.element),
    );
    if (focusedRowId !== undefined && focused instanceof HTMLElement && !focused.isConnected) {
      this.refocus(focused, this.rows.get(focusedRowId)?.element, focusedIndex, typed);
    }

    const full = this.current.length >= MAX_LABELS;
    this.addButton.disabled = full;
    this.limitHint.hidden = !full;
    // A description is read even from a hidden element, so link the hint only while it shows.
    if (full) this.addButton.setAttribute("aria-describedby", LIMIT_HINT_ID);
    else this.addButton.removeAttribute("aria-describedby");
  }

  private refocus(
    lost: HTMLElement,
    row: HTMLElement | undefined,
    index: number,
    typed: { value: string; start: number | null; end: number | null } | undefined,
  ): void {
    if (!row) {
      const next = this.list.querySelectorAll<HTMLButtonElement>(".label-row__toggle")[index];
      (next ?? this.addButton).focus();
      return;
    }
    const key = controlKey(lost);
    const control =
      [...row.querySelectorAll<HTMLElement>("input, button")].find(
        (candidate) => controlKey(candidate) === key,
      ) ?? row.querySelector<HTMLElement>(".label-row__toggle");
    control?.focus();
    // The only text not yet in the label: an address typed but not added.
    if (control instanceof HTMLInputElement && typed) {
      if (!control.matches(".host-input__field")) return;
      control.value = typed.value;
      control.setSelectionRange(typed.start, typed.end);
    }
  }

  private toggle(id: string): void {
    this.openId = this.openId === id ? null : id;
    this.render();
    this.list
      .querySelector<HTMLButtonElement>(`[data-label-id="${CSS.escape(id)}"] .label-row__toggle`)
      ?.focus();
  }

  private row(label: LabelRule, isOpen: boolean): HTMLElement {
    const panelId = `label-panel-${label.id}`;
    const chip = labelChip(label);
    const summary = h("span", { className: "label-row__summary", text: labelSummary(label) });
    const toggle = h(
      "button",
      {
        className: "label-row__toggle",
        attributes: {
          type: "button",
          "aria-expanded": String(isOpen),
          ...(isOpen ? { "aria-controls": panelId } : {}),
          "aria-label": `${isOpen ? "Done editing" : "Edit"} label ${label.text}`,
        },
      },
      [h("span", { text: isOpen ? "Done" : "Edit" }), icon("chevron-down")],
    );
    toggle.addEventListener("click", () => {
      this.toggle(label.id);
    });

    // A row replaced by show() can still report its field's blur; its label is gone from the list.
    const edit: LabelEdit = (changes) => {
      if (this.rows.get(label.id)?.element !== row) return;
      const current = this.update(label.id, changes);
      if (!current) return;
      chip.className = chipClass(current);
      chip.textContent = current.text;
      summary.textContent = labelSummary(current);
      toggle.setAttribute("aria-label", `Done editing label ${current.text}`);
      const heading = row.querySelector(".host-input__heading");
      if (heading) heading.textContent = hostsHeading(current);
    };

    const row = h(
      "div",
      {
        className: `label-row${isOpen ? " is-open" : ""}`,
        attributes: { "data-label-id": label.id },
      },
      [
        h("div", { className: "label-row__header" }, [chip, summary, toggle]),
        isOpen &&
          h("div", { className: "label-row__panel", attributes: { id: panelId } }, [
            this.nameAndColour(label, edit),
            this.hostInput(label, edit),
            this.privateNetworkToggle(label, edit),
            this.deleteButton(label),
          ]),
      ],
    );
    return row;
  }

  private nameAndColour(label: LabelRule, edit: LabelEdit): HTMLElement {
    const name = h("input", {
      className: "label-editor__name",
      attributes: {
        type: "text",
        value: label.text,
        maxlength: String(MAX_LABEL_LENGTH),
        "aria-label": "Label name",
      },
    });
    // A label needs a name: clearing it keeps the previous one rather than deleting the label.
    name.addEventListener("input", () => {
      if (name.value.trim()) edit({ text: name.value });
    });
    name.addEventListener("blur", () => {
      if (!name.value.trim()) {
        name.value = this.current.find((other) => other.id === label.id)?.text ?? label.text;
      }
    });

    const colours = h(
      "div",
      {
        className: "label-editor__colours",
        attributes: { role: "radiogroup", "aria-label": "Label colour" },
      },
      LABEL_COLORS.map((color) => {
        const swatch = h("input", {
          className: `label-editor__colour chip--${color}`,
          attributes: {
            type: "radio",
            name: `label-colour-${label.id}`,
            value: color,
            "aria-label": COLOUR_NAMES[color],
            ...(color === label.color ? { checked: "" } : {}),
          },
        });
        swatch.addEventListener("change", () => {
          edit({ color });
        });
        return swatch;
      }),
    );

    return h("div", { className: "label-editor__name-row" }, [name, colours]);
  }

  private hostInput(label: LabelRule, edit: LabelEdit): HTMLElement {
    let hosts = [...label.hosts];
    const headingId = `label-hosts-${label.id}`;
    const hintId = `label-hosts-hint-${label.id}`;
    const chips = h("ul", {
      className: "host-chips",
      attributes: { "aria-label": "Added addresses" },
    });
    const input = h("input", {
      className: "host-input__field",
      attributes: {
        type: "text",
        placeholder: "jira.acme.com, *.atlassian.net, 10.*",
        "aria-labelledby": headingId,
        "aria-describedby": hintId,
        autocomplete: "off",
        spellcheck: "false",
      },
    });
    const count = h("span", { className: "host-input__count" });

    const save = (next: string[]) => {
      hosts = next;
      edit({ hosts });
      renderChips();
    };
    const commit = (text: string) => {
      input.value = "";
      if (text.trim()) save(addHosts(hosts, text));
    };
    const hostChip = (host: string) => {
      const remove = h(
        "button",
        {
          className: "host-chip__remove",
          attributes: { type: "button", "aria-label": `Remove ${host}` },
        },
        [icon("close")],
      );
      // Keeps focus in the text field: a blur there would commit its text and rebuild the chips
      // under the pointer, swallowing this click.
      remove.addEventListener("pointerdown", (event) => {
        event.preventDefault();
      });
      remove.addEventListener("click", () => {
        save(hosts.filter((other) => other !== host));
        input.focus();
      });
      return h("li", { className: "host-chip" }, [
        h("span", { className: "host-chip__text", text: host }),
        remove,
      ]);
    };
    // Chips are kept across renders: Shift+Tab out of a half-typed address commits it, and a
    // rebuilt chip would drop the focus heading for its Remove button.
    let chipFor = new Map<string, HTMLElement>();
    const renderChips = () => {
      chipFor = new Map(hosts.map((host) => [host, chipFor.get(host) ?? hostChip(host)]));
      reconcileChildren(chips, [...chipFor.values()]);
      // Read-only rather than disabled, so a field that fills up keeps keyboard focus.
      const full = hosts.length >= MAX_HOST_PATTERNS;
      input.readOnly = full;
      input.setAttribute("aria-disabled", String(full));
      count.textContent = full
        ? `That's the limit of ${MAX_HOST_PATTERNS} addresses.`
        : "Press Enter to add. Paste a list to add many at once.";
    };
    renderChips();

    input.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (event.key === "Enter" || event.key === ",") {
        event.preventDefault();
        commit(input.value);
      } else if (
        event.key === "Backspace" &&
        !event.repeat &&
        input.value === "" &&
        hosts.length > 0
      ) {
        event.preventDefault();
        save(hosts.slice(0, -1));
      }
    });
    input.addEventListener("paste", (event) => {
      const text = event.clipboardData?.getData("text") ?? "";
      if (!/[\s,]/.test(text.trim())) return;
      event.preventDefault();
      const { value, selectionStart, selectionEnd } = input;
      const start = selectionStart ?? value.length;
      commit(value.slice(0, start) + text + value.slice(selectionEnd ?? start));
    });
    input.addEventListener("blur", () => {
      commit(input.value);
    });

    const box = h("div", { className: "host-input__box" }, [chips, input]);
    box.addEventListener("click", (event) => {
      if (event.target === box) input.focus();
    });

    return h("div", { className: "host-input" }, [
      h("p", {
        className: "host-input__heading",
        text: hostsHeading(label),
        attributes: { id: headingId },
      }),
      box,
      h("p", { className: "host-input__hint", attributes: { id: hintId } }, [
        count,
        " Use * as a wildcard: *.acme.com covers acme.com and all its subdomains.",
      ]),
    ]);
  }

  private privateNetworkToggle(label: LabelRule, edit: LabelEdit): HTMLElement {
    const checkbox = h("input", {
      attributes: { type: "checkbox", ...(label.privateNetwork ? { checked: "" } : {}) },
    });
    checkbox.addEventListener("change", () => {
      edit({ privateNetwork: checkbox.checked });
    });
    return h("label", { className: "settings__check" }, [
      checkbox,
      h("span", { text: "Also private-network addresses (10.x, 192.168.x, localhost, *.local …)" }),
    ]);
  }

  private deleteButton(label: LabelRule): HTMLElement {
    const remove = h("button", {
      className: "label-row__delete",
      text: "Delete label",
      attributes: { type: "button" },
    });
    remove.addEventListener("click", () => {
      this.delete(label.id);
    });
    return remove;
  }

  private delete(id: string): void {
    const index = this.current.findIndex((label) => label.id === id);
    const label = this.current[index];
    if (!label) return;
    const tagged = [
      label.privateNetwork && "private-network addresses",
      label.hosts.length > 0 && addressCount(label.hosts.length),
    ].filter((part) => part !== false);
    const confirmation = `Delete ${label.text} and its ${tagged.join(" and ")}?`;
    if (tagged.length > 0 && !window.confirm(confirmation)) return;

    this.current = this.current.filter((other) => other !== label);
    this.onChange(this.current);
    this.openId = null;
    this.render();
    const next = this.list.querySelectorAll<HTMLButtonElement>(".label-row__toggle")[index];
    (next ?? this.addButton).focus();
  }
}
