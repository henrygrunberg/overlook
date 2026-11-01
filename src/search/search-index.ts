import type { Bookmark, Folder, Library } from "../bookmarks/library";
import { acronym, boundedEditDistance, normalize, splitWords, subsequenceScore } from "./text";

export interface SearchHit<T> {
  readonly item: T;
  readonly score: number;
}

export interface SearchResults {
  readonly folders: readonly SearchHit<Folder>[];
  readonly bookmarks: readonly SearchHit<Bookmark>[];
}

export interface SearchOptions {
  readonly scopeFolderId?: string | undefined;
  readonly folderLimit?: number;
  readonly bookmarkLimit?: number;
  /** Extra ranking for a bookmark, e.g. from how often it is opened; roughly 0–0.3. */
  readonly bookmarkBoost?: (bookmark: Bookmark) => number;
}

interface Field {
  readonly text: string;
  readonly words: readonly string[];
  readonly weight: number;
}

interface IndexedEntry<T> {
  readonly item: T;
  readonly ancestorIds: readonly string[];
  readonly title: string;
  readonly acronym: string;
  readonly fields: readonly Field[];
}

const TITLE_WEIGHT = 1;
const HOST_WEIGHT = 0.75;
const PATH_WEIGHT = 0.7;
const LABEL_WEIGHT = 0.7;
const MIN_TYPO_LENGTH = 4;
const LONG_TOKEN_LENGTH = 8;
// One of these characters is a whole word, unlike one Latin letter.
const IDEOGRAPHIC = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function field(text: string, weight: number): Field {
  const normalized = normalize(text);
  return { text: normalized, words: splitWords(normalized), weight };
}

function indexEntry<T>(
  item: T,
  ancestorIds: readonly string[],
  title: string,
  fields: readonly Field[],
): IndexedEntry<T> {
  const titleField = field(title, TITLE_WEIGHT);
  return {
    item,
    ancestorIds,
    title: titleField.text,
    acronym: acronym(titleField.words),
    fields: [titleField, ...fields],
  };
}

function scoreWord(token: string, word: string): number {
  if (word === token) return 1;
  if (word.startsWith(token)) return 0.8 + 0.1 * (token.length / word.length);
  if (token.length < MIN_TYPO_LENGTH) return 0;

  const maxTypos = token.length >= LONG_TOKEN_LENGTH ? 2 : 1;
  const wholeWord = boundedEditDistance(token, word, maxTypos);
  if (wholeWord <= maxTypos) return 0.55 - 0.15 * wholeWord;
  if (word.length > token.length) {
    const typedSoFar = boundedEditDistance(token, word.slice(0, token.length), maxTypos);
    if (typedSoFar <= maxTypos) return 0.5 - 0.15 * typedSoFar;
  }
  return 0;
}

class TokenMatcher {
  private readonly wordScores = new Map<string, number>();

  constructor(readonly token: string) {}

  scoreField(field: Field): number {
    let best = 0;
    for (const word of field.words) {
      let score = this.wordScores.get(word);
      if (score === undefined) {
        score = scoreWord(this.token, word);
        this.wordScores.set(word, score);
      }
      if (score > best) best = score;
      if (best === 1) return 1;
    }
    if (best >= 0.8) return best;
    if (
      (this.token.length >= 2 || IDEOGRAPHIC.test(this.token)) &&
      field.text.includes(this.token)
    ) {
      return Math.max(best, 0.65);
    }
    if (best > 0 || this.token.length < 3) return best;
    const spread = subsequenceScore(this.token, field.text);
    return spread >= 0.5 ? 0.3 * spread : 0;
  }

  scoreEntry(entry: IndexedEntry<unknown>): number {
    let best = 0;
    for (const field of entry.fields) {
      best = Math.max(best, this.scoreField(field) * field.weight);
      if (best >= TITLE_WEIGHT) break;
    }
    if (best < 0.75 && this.token.length >= 2 && entry.acronym.startsWith(this.token)) {
      best = 0.75;
    }
    return best;
  }
}

function queryScore(
  entry: IndexedEntry<unknown>,
  matchers: readonly TokenMatcher[],
  query: string,
): number {
  let total = 0;
  for (const matcher of matchers) {
    const score = matcher.scoreEntry(entry);
    if (score === 0) return 0;
    total += score;
  }
  const average = total / matchers.length;
  return entry.title.startsWith(query) ? average + 0.1 : average;
}

function rank<T>(
  entries: readonly IndexedEntry<T>[],
  matchers: readonly TokenMatcher[],
  query: string,
  inScope: (entry: IndexedEntry<T>) => boolean,
  boost: (item: T) => number,
  limit: number,
): SearchHit<T>[] {
  const hits: (SearchHit<T> & { readonly title: string })[] = [];
  for (const entry of entries) {
    if (!inScope(entry)) continue;
    const score = matchers.length === 0 ? 0.5 : queryScore(entry, matchers, query);
    if (score > 0)
      hits.push({ item: entry.item, score: score + boost(entry.item), title: entry.title });
  }
  hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return hits.slice(0, limit).map(({ item, score }) => ({ item, score }));
}

export class SearchIndex {
  private readonly folders: readonly IndexedEntry<Folder>[];
  private readonly bookmarks: readonly IndexedEntry<Bookmark>[];

  constructor(library: Library, labelsOf: (bookmark: Bookmark) => readonly string[] = () => []) {
    this.folders = library.folders.map((folder) =>
      indexEntry(folder, folder.ancestorIds, folder.title, [
        field(folder.path.slice(0, -1).join(" "), PATH_WEIGHT),
      ]),
    );
    this.bookmarks = library.bookmarks.map((bookmark) =>
      indexEntry(bookmark, bookmark.ancestorIds, bookmark.title, [
        field(bookmark.host, HOST_WEIGHT),
        field(bookmark.path.join(" "), PATH_WEIGHT),
        field(labelsOf(bookmark).join(" "), LABEL_WEIGHT),
      ]),
    );
  }

  search(query: string, options: SearchOptions = {}): SearchResults {
    const normalizedQuery = normalize(query.trim());
    // Titles are split on punctuation too, but "c++" alone must not become just "c".
    const tokens = [
      ...new Set(
        normalizedQuery
          .split(/\s+/)
          .filter(Boolean)
          .flatMap((part) => {
            const words = splitWords(part);
            return words.length > 1 ? words : [part];
          }),
      ),
    ];
    const scope = options.scopeFolderId;
    if (tokens.length === 0 && scope === undefined) return { folders: [], bookmarks: [] };

    const matchers = tokens.map((token) => new TokenMatcher(token));
    const inScope = (entry: IndexedEntry<unknown>) =>
      scope === undefined || entry.ancestorIds.includes(scope);
    const bookmarkBoost = options.bookmarkBoost ?? (() => 0);

    return {
      folders: rank(
        this.folders,
        matchers,
        normalizedQuery,
        inScope,
        () => 0,
        options.folderLimit ?? 4,
      ),
      bookmarks: rank(
        this.bookmarks,
        matchers,
        normalizedQuery,
        inScope,
        bookmarkBoost,
        options.bookmarkLimit ?? 8,
      ),
    };
  }
}
