export function countOf(count: number, noun: string, plural = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : plural}`;
}

export const folderPath = (titles: readonly string[]) => titles.join(" › ");
