// Only accents: elsewhere a mark can make a different word (Devanagari vowel signs, Thai tone
// marks, Japanese voicing), and an emoji's variation selector is part of the emoji.
const ACCENTS =
  /(?<=[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Hebrew}\p{Script=Arabic}]\p{M}*)\p{M}+/gu;
const WORD = /[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu;
// Letters that NFKD keeps whole, so they have no accent to strip.
const UNDECOMPOSED_LETTERS = new Map([
  ["ß", "ss"],
  ["æ", "ae"],
  ["œ", "oe"],
  ["ø", "o"],
  ["đ", "d"],
  ["ð", "d"],
  ["ł", "l"],
  ["ı", "i"],
  ["þ", "th"],
  ["ħ", "h"],
  ["ŧ", "t"],
]);
const UNDECOMPOSED = new RegExp(`[${[...UNDECOMPOSED_LETTERS.keys()].join("")}]`, "g");

/** Lower-cases and strips accents so "Café analüütika" matches "cafe analuutika". */
export function normalize(text: string): string {
  return text
    .normalize("NFKD")
    .replace(ACCENTS, "")
    .toLowerCase()
    .replace(UNDECOMPOSED, (letter) => UNDECOMPOSED_LETTERS.get(letter) ?? letter);
}

export function splitWords(normalized: string): string[] {
  return normalized.match(WORD) ?? [];
}

/** "IoT Grafana" → "ig", "LoadTesting" stays one word, so → "l". */
export function acronym(words: readonly string[]): string {
  return words.map((word) => word[0]).join("");
}

const distanceRow: number[] = [];
const previousRow: number[] = [];
const beforePreviousRow: number[] = [];

/** Optimal string alignment (Levenshtein plus transpositions); `max + 1` once beyond `max`. */
export function boundedEditDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a === b) return 0;

  for (let j = 0; j <= b.length; j++) {
    previousRow[j] = j;
    beforePreviousRow[j] = j;
  }
  for (let i = 1; i <= a.length; i++) {
    distanceRow[0] = i;
    let rowMinimum = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        (previousRow[j] ?? 0) + 1,
        (distanceRow[j - 1] ?? 0) + 1,
        (previousRow[j - 1] ?? 0) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, (beforePreviousRow[j - 2] ?? 0) + 1);
      }
      distanceRow[j] = value;
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > max) return max + 1;
    for (let j = 0; j <= b.length; j++) {
      beforePreviousRow[j] = previousRow[j] ?? 0;
      previousRow[j] = distanceRow[j] ?? 0;
    }
  }
  return Math.min(previousRow[b.length] ?? max + 1, max + 1);
}

/** 1 when `needle` is contiguous in `haystack`, towards 0 as it spreads out, 0 if not in order. */
export function subsequenceScore(needle: string, haystack: string): number {
  if (needle === "") return 0;
  let bestSpan = Infinity;
  for (let start = haystack.indexOf(needle.charAt(0)); start !== -1;) {
    let position = start;
    let matched = 1;
    while (matched < needle.length) {
      position = haystack.indexOf(needle.charAt(matched), position + 1);
      if (position === -1) break;
      matched++;
    }
    if (matched < needle.length) break;
    bestSpan = Math.min(bestSpan, position - start + 1);
    start = haystack.indexOf(needle.charAt(0), start + 1);
  }
  return bestSpan === Infinity ? 0 : needle.length / bestSpan;
}
