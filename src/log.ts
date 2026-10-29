export function warn(action: string, error: unknown): void {
  console.warn(`Overlook: could not ${action}`, error);
}

export function warnOnFailure(action: string): (error: unknown) => void {
  return (error) => {
    warn(action, error);
  };
}
