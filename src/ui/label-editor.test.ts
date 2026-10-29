import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_HOST_PATTERNS,
  MAX_LABEL_LENGTH,
  MAX_LABELS,
  type LabelRule,
} from "../settings/settings";
import { addHosts, LabelEditor, labelSummary } from "./label-editor";

const VPN: LabelRule = { id: "vpn", text: "VPN", color: "green", privateNetwork: true, hosts: [] };
const WORK: LabelRule = {
  id: "work",
  text: "Work",
  color: "blue",
  privateNetwork: false,
  hosts: ["jira.acme.com"],
};

function mount(labels: readonly LabelRule[]) {
  const saved: (readonly LabelRule[])[] = [];
  const editor = new LabelEditor(labels, (next) => {
    saved.push(structuredClone(next));
  });
  document.body.replaceChildren(editor.element);
  const row = (id: string) => {
    const element = editor.element.querySelector<HTMLElement>(`[data-label-id="${id}"]`);
    if (!element) throw new Error(`No row for ${id}`);
    return element;
  };
  const open = (id: string) => {
    row(id).querySelector<HTMLButtonElement>(".label-row__toggle")?.click();
    const input = row(id).querySelector<HTMLInputElement>(".host-input__field");
    if (!input) throw new Error(`Row ${id} did not open`);
    return input;
  };
  const chips = (id: string) =>
    [...row(id).querySelectorAll(".host-chip__text")].map((chip) => chip.textContent);
  const last = () => saved.at(-1);
  return { editor, row, open, chips, last };
}

const key = (input: HTMLInputElement, name: string, repeat = false) =>
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: name, repeat, bubbles: true, cancelable: true }),
  );

const labelsNamed = (count: number): LabelRule[] =>
  Array.from({ length: count }, (_, index) => ({ ...WORK, id: `label-${index}`, hosts: [] }));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("labelSummary", () => {
  it("says what a closed label covers", () => {
    expect(labelSummary(VPN)).toBe("Private networks");
    expect(labelSummary(WORK)).toBe("1 address");
    expect(labelSummary({ ...VPN, hosts: ["a.com", "b.com"] })).toBe(
      "Private networks + 2 addresses",
    );
    expect(labelSummary({ ...WORK, hosts: [] })).toBe("No addresses yet");
  });
});

describe("addHosts", () => {
  it("adds new patterns once and stops at the limit", () => {
    expect(addHosts(["a.com"], "A.com b.com, b.com")).toEqual(["a.com", "b.com"]);
    const many = Array.from({ length: MAX_HOST_PATTERNS }, (_, index) => `${index}.example.com`);
    expect(addHosts(many, "one-more.com")).toHaveLength(MAX_HOST_PATTERNS);
  });
});

describe("LabelEditor", () => {
  it("shows compact rows and opens one label at a time", () => {
    const { row, open } = mount([VPN, WORK]);
    expect(row("vpn").querySelector(".label-row__summary")?.textContent).toBe("Private networks");
    expect(row("vpn").querySelector(".label-row__panel")).toBeNull();

    open("vpn");
    open("work");
    expect(row("vpn").querySelector(".label-row__panel")).toBeNull();
    expect(row("work").querySelector(".host-input__heading")?.textContent).toBe(
      "Addresses tagged Work",
    );
  });

  it("adds an address on Enter and removes the last one on Backspace", () => {
    const { open, chips, last, row } = mount([WORK]);
    const input = open("work");

    input.value = "https://wiki.acme.com/start";
    key(input, "Enter");
    expect(chips("work")).toEqual(["jira.acme.com", "wiki.acme.com"]);
    expect(last()?.[0]?.hosts).toEqual(["jira.acme.com", "wiki.acme.com"]);
    expect(row("work").querySelector(".label-row__summary")?.textContent).toBe("2 addresses");

    key(input, "Backspace");
    expect(chips("work")).toEqual(["jira.acme.com"]);
  });

  it("ignores a held-down Backspace, so key repeat can't empty the list", () => {
    const { open, chips } = mount([{ ...WORK, hosts: ["a.example.com", "b.example.com"] }]);
    const input = open("work");
    key(input, "Backspace", true);
    expect(chips("work")).toEqual(["a.example.com", "b.example.com"]);
  });

  it("keeps the address field focused, but read-only, when it reaches the limit", () => {
    const almostFull = Array.from(
      { length: MAX_HOST_PATTERNS - 1 },
      (_, index) => `${index}.example.com`,
    );
    const { open, row } = mount([{ ...WORK, hosts: almostFull }]);
    const input = open("work");
    input.focus();
    input.value = "last.example.com";
    key(input, "Enter");

    expect(document.activeElement).toBe(input);
    expect(input.readOnly).toBe(true);
    expect(input.getAttribute("aria-disabled")).toBe("true");
    expect(row("work").querySelector(".host-input__count")?.textContent).toBe(
      `That's the limit of ${MAX_HOST_PATTERNS} addresses.`,
    );
    const description = document.getElementById(input.getAttribute("aria-describedby") ?? "");
    expect(description?.textContent).toContain(
      `That's the limit of ${MAX_HOST_PATTERNS} addresses.`,
    );
  });

  it("picks the colour from one native radio group per label", () => {
    const { open, row, last } = mount([WORK]);
    open("work");
    const swatches = [...row("work").querySelectorAll<HTMLInputElement>(".label-editor__colour")];
    const groupName = swatches[0]?.name;
    expect(swatches.every((swatch) => swatch.type === "radio" && swatch.name === groupName)).toBe(
      true,
    );
    expect(swatches.find((swatch) => swatch.checked)?.value).toBe("blue");

    swatches.find((swatch) => swatch.value === "red")?.click();
    expect(last()?.[0]?.color).toBe("red");
    expect(swatches.filter((swatch) => swatch.checked).map((swatch) => swatch.value)).toEqual([
      "red",
    ]);
    expect(row("work").querySelector(".label-row__header .chip")?.className).toBe("chip chip--red");
  });

  it("limits label names to the length settings keep", () => {
    const { open, row } = mount([WORK]);
    open("work");
    expect(row("work").querySelector(".label-editor__name")?.getAttribute("maxlength")).toBe(
      String(MAX_LABEL_LENGTH),
    );
  });

  it("stops offering new labels at the limit", () => {
    const { editor } = mount(labelsNamed(MAX_LABELS - 1));
    const add = editor.element.querySelector<HTMLButtonElement>(".settings__action");
    const hint = editor.element.querySelector<HTMLElement>(".label-editor__limit");
    expect(add?.disabled).toBe(false);
    expect(hint?.hidden).toBe(true);
    expect(add?.hasAttribute("aria-describedby")).toBe(false);

    add?.click();
    expect(editor.element.querySelectorAll(".label-row")).toHaveLength(MAX_LABELS);
    expect(add?.disabled).toBe(true);
    expect(hint?.hidden).toBe(false);
    expect(hint?.textContent).toBe(`That's the limit of ${MAX_LABELS} labels.`);
    expect(add?.getAttribute("aria-describedby")).toBe(hint?.id);
  });

  const paste = (input: HTMLInputElement, text: string) => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
    input.dispatchEvent(event);
    return event;
  };

  it("adds every address of a pasted list", () => {
    const { open, chips } = mount([WORK]);
    const input = open("work");
    expect(paste(input, "10.*\n*.atlassian.net\njira.acme.com").defaultPrevented).toBe(true);
    expect(chips("work")).toEqual(["jira.acme.com", "10.*", "*.atlassian.net"]);
  });

  it("puts a pasted list in place of the selected text", () => {
    const { open, chips } = mount([WORK]);
    const input = open("work");
    input.value = "acme.com";
    input.setSelectionRange(0, input.value.length);
    paste(input, "a.com, b.com");
    expect(chips("work")).toEqual(["jira.acme.com", "a.com", "b.com"]);
  });

  it("shows addresses as text, never as markup", () => {
    const { open, row } = mount([{ ...WORK, hosts: ["<img src=x>"] }]);
    open("work");
    expect(row("work").querySelector("img")).toBeNull();
  });

  it("deletes a label with addresses only after confirming, then focuses the next row", () => {
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal("confirm", confirm);
    const { open, row, last, editor } = mount([WORK, VPN]);
    open("work");
    const remove = () => row("work").querySelector<HTMLButtonElement>(".label-row__delete");

    remove()?.click();
    expect(confirm).toHaveBeenLastCalledWith("Delete Work and its 1 address?");
    expect(editor.element.querySelectorAll(".label-row")).toHaveLength(2);

    remove()?.click();
    expect(last()?.map((label) => label.id)).toEqual(["vpn"]);
    expect(editor.element.querySelectorAll(".label-row")).toHaveLength(1);
    expect(document.activeElement).toBe(row("vpn").querySelector(".label-row__toggle"));
  });

  it("deletes a label without addresses straight away and focuses New label when none is left", () => {
    const confirm = vi.fn();
    vi.stubGlobal("confirm", confirm);
    const { open, row, last, editor } = mount([VPN]);
    open("vpn");
    row("vpn").querySelector<HTMLButtonElement>(".label-row__delete")?.click();

    expect(confirm).not.toHaveBeenCalled();
    expect(last()).toEqual([]);
    expect(document.activeElement).toBe(editor.element.querySelector(".settings__action"));
  });
});
