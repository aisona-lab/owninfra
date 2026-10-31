/** The database a destructive run may reset: its name must end in _builder or _verifier. Prints the name either way. */
export function throwawayDatabase(url: string, who: string, log: (line: string) => void = console.log): string {
  const name = new URL(url).pathname.slice(1);
  log(`${who} resets the public schema of database '${name}'`);
  if (!/_(builder|verifier)$/.test(name)) throw new Error(`refusing to reset '${name}': the name must end in _builder or _verifier`);
  return name;
}
