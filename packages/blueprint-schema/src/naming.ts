const reserved = new Set(
  "all analyse analyze and any array as asc asymmetric authorization binary both case cast check collate collation column concurrently constraint create cross current_catalog current_date current_role current_schema current_time current_timestamp current_user default deferrable desc distinct do else end except false fetch for foreign freeze from full grant group having ilike in initially inner intersect into is isnull join lateral leading left like limit localtime localtimestamp natural not notnull null offset on only or order outer overlaps placing primary references returning right select session_user similar some symmetric system_user table tablesample then to trailing true union unique user using variadic verbose when where window with".split(" "),
);
const systemColumns = new Set(["id", "created_at", "updated_at", "created_by"]);
export const maxIdentifier = 63;

export function snake(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z])([A-Z][a-z])/g, "$1_$2").toLowerCase();
}

export function plural(word: string): string {
  if (/[^aeiou]y$/.test(word)) return word.slice(0, -1) + "ies";
  if (/(s|x|z|ch|sh)$/.test(word)) return word + "es";
  return word + "s";
}

export const tableName = (entity: string) => plural(snake(entity));

export function sqlIdentifierProblem(name: string): string | undefined {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) return `'${name}' must be lowercase snake_case to be a SQL identifier`;
  if (reserved.has(name)) return `'${name}' is a reserved word in Postgres`;
  if (Buffer.byteLength(name) > maxIdentifier) return `'${name}' is longer than ${maxIdentifier} bytes`;
  return undefined;
}

export const isSystemColumn = (name: string) => systemColumns.has(name);
