const reserved = new Set(
  "all analyse analyze and any array as asc asymmetric authorization binary both case cast check collate collation column concurrently constraint create cross current_catalog current_date current_role current_schema current_time current_timestamp current_user default deferrable desc distinct do else end except false fetch for foreign freeze from full grant group having ilike in initially inner intersect into is isnull join lateral leading left like limit localtime localtimestamp natural not notnull null offset on only or order outer overlaps placing primary references returning right select session_user similar some symmetric system_user table tablesample then to trailing true union unique user using variadic verbose when where window with".split(" "),
);
const systemColumns = new Set(["id", "created_at", "updated_at", "created_by"]);
export const maxIdentifier = 63;

export function snake(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z])([A-Z][a-z])/g, "$1_$2").toLowerCase();
}

const irregular: Readonly<Record<string, string>> = {
  person: "people",
  child: "children",
  man: "men",
  woman: "women",
  mouse: "mice",
  goose: "geese",
  tooth: "teeth",
  foot: "feet",
  datum: "data",
  index: "indices",
  alias: "aliases",
  bias: "biases",
  leaf: "leaves",
  half: "halves",
  knife: "knives",
  life: "lives",
  wife: "wives",
  shelf: "shelves",
  wolf: "wolves",
  thief: "thieves",
  loaf: "loaves",
  calf: "calves",
  matrix: "matrices",
  vertex: "vertices",
};
const pluralForms = new Set(Object.values(irregular));
const uncountable = new Set(["data", "equipment", "information", "metadata", "news", "series", "species", "staff"]);

export function plural(word: string): string {
  const parts = word.split("_");
  const last = parts.pop()!;
  return [...parts, pluralWord(last)].join("_");
}

function pluralWord(w: string): string {
  if (irregular[w]) return irregular[w];
  if (pluralForms.has(w) || uncountable.has(w)) return w;
  if (/(ses|xes|zes|ches|shes|ies)$/.test(w)) return w;
  if (/[^aeiou]y$/.test(w)) return w.slice(0, -1) + "ies";
  if (/(ss|us|x|z|ch|sh)$/.test(w)) return w + "es";
  if (/is$/.test(w)) return w.slice(0, -2) + "es";
  if (/s$/.test(w)) return w;
  return w + "s";
}

export const tableName = (entity: string, override?: string) => override ?? plural(snake(entity));

export function sqlIdentifierProblem(name: string): string | undefined {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) return `'${name}' must be lowercase snake_case to be a SQL identifier`;
  if (reserved.has(name)) return `'${name}' is a reserved word in Postgres`;
  if (name.startsWith("pg_")) return `'${name}' starts with 'pg_', which Postgres reserves for its catalog (pg_catalog is searched first, so it would shadow the table)`;
  if (Buffer.byteLength(name) > maxIdentifier) return `'${name}' is longer than ${maxIdentifier} bytes`;
  return undefined;
}

export const isSystemColumn = (name: string) => systemColumns.has(name);
