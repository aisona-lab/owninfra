export type CrudAction = "create" | "read" | "update" | "delete";

export type Column = {
  name: string;
  label: string;
  input: "string" | "text" | "email" | "int" | "decimal" | "bool" | "date" | "datetime" | "enum" | "ref";
  required: boolean;
  unique: boolean;
  ref: string | null;
  values: string[] | null;
  default: string | number | boolean | null;
  min: number | null;
  max: number | null;
  pattern: string | null;
};

export type Transition = {
  id: string;
  from: string;
  to: string;
  roles: string[];
  ownerOnly: boolean;
  forbidCreator: boolean;
  requireFields: string[];
  forbiddenFor: string[];
};

export type Workflow = {
  field: string;
  initial: string;
  states: { id: string; label: string; final: boolean }[];
  transitions: Transition[];
};

export type EntityDef = {
  entity: string;
  table: string;
  label: string;
  display: string;
  owned: boolean;
  columns: Column[];
  workflow: Workflow | null;
};

export type Policy = { entity: string; role: string; action: CrudAction; scope: "all" | "own"; inStates: string[] | null };

export type Registry = {
  app: { name: string; title: string };
  roles: string[];
  entities: EntityDef[];
  policies: Policy[];
  seedUsers: { email: string; roles: string[] }[];
  audit: { enabled: boolean };
};

export type Row = Record<string, unknown> & { id: string; created_by: string };

export type User = { email: string; roles: readonly string[] };
