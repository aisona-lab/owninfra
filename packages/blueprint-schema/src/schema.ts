import { z } from "zod";

const id = z.string().regex(/^[a-z][a-z0-9_-]*$/, "must be lowercase snake/kebab case");
const entityName = z.string().regex(/^[A-Z][A-Za-z0-9]*$/, "must be PascalCase");

const scalarTypes = ["string", "text", "int", "decimal", "bool", "date", "datetime", "email"] as const;

const fieldBase = {
  name: id,
  label: z.string().optional(),
  required: z.boolean().optional(),
  unique: z.boolean().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  visible_when: z.string().optional(),
};

export const Field = z.discriminatedUnion("type", [
  z
    .object({
      ...fieldBase,
      type: z.enum(scalarTypes),
      min: z.number().optional(),
      max: z.number().optional(),
      pattern: z.string().optional(),
      precision: z.number().int().positive().optional(),
      scale: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z.object({ ...fieldBase, type: z.literal("enum"), values: z.array(z.string()).min(1) }).strict(),
  z.object({ ...fieldBase, type: z.literal("ref"), to: entityName }).strict(),
  z
    .object({ ...fieldBase, type: z.literal("files"), max_files: z.number().optional(), max_mb: z.number().optional() })
    .strict(),
]);

const State = z.object({ id, label: z.string().optional(), final: z.boolean().optional() }).strict();

const Transition = z
  .object({
    id,
    from: id,
    to: id,
    roles: z.array(id).min(1),
    only_owner: z.boolean().optional(),
    require_fields: z.array(id).optional(),
    when: z.string().optional(),
  })
  .strict();

const Workflow = z
  .object({
    field: id,
    initial: id,
    states: z.array(State).min(1),
    transitions: z.array(Transition),
    separation_of_duties: z.boolean().optional(),
    notify: z.array(z.unknown()).optional(),
  })
  .strict();

const Entity = z
  .object({
    name: entityName,
    table: z.string().regex(/^[a-z_][a-z0-9_]*$/, "must be a lowercase snake_case SQL identifier").optional(),
    label: z.string().optional(),
    fields: z.array(Field).min(1),
    display: id.optional(),
    ownership: z.literal("created_by").optional(),
    list: z
      .object({
        columns: z.array(id).optional(),
        default_sort: z.object({ field: id, dir: z.enum(["asc", "desc"]) }).optional(),
        filters: z.array(id).optional(),
        search: z.array(id).optional(),
      })
      .strict()
      .optional(),
    workflow: Workflow.optional(),
  })
  .strict();

export const crudActions = ["create", "read", "update", "delete"] as const;
const Scope = z.enum(["all", "own"]);
const Rule = z.union(
  [z.boolean(), Scope, z.object({ own: z.boolean().optional(), in_states: z.array(id).optional() }).strict()],
  { errorMap: () => ({ message: "must be true, false, 'all', 'own' or { own, in_states }" }) },
);
const RolePermission = z.union(
  [
    z.array(z.enum(crudActions)),
    z.object({ create: Rule.optional(), read: Rule.optional(), update: Rule.optional(), delete: Rule.optional() }).strict(),
  ],
  { errorMap: () => ({ message: "must be a list of actions (create, read, update, delete) or a map of action to rule" }) },
);

const Environment = z
  .object({
    account: z.string().regex(/^\d{12}$/, "must be a 12-digit AWS account id"),
    region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/, "must be an AWS region"),
    compute: z
      .object({ cpu: z.number().int(), memory: z.number().int(), desired: z.number().int(), max: z.number().int() })
      .strict()
      .optional(),
    database: z
      .object({
        instance: z.string(),
        multi_az: z.boolean().optional(),
        backup_days: z.number().int().optional(),
        deletion_protection: z.boolean().optional(),
      })
      .strict()
      .optional(),
    seed_users: z.boolean().optional(),
    removal_policy: z.enum(["destroy", "snapshot", "retain"]).optional(),
    deploy: z.record(z.unknown()).optional(),
  })
  .strict();

export const Blueprint = z
  .object({
    version: z.union([z.literal(0.1), z.literal("0.1")], {
      errorMap: (_, ctx) => ({ message: ctx.data === undefined ? "Required" : "must be 0.1" }),
    }),
    app: z
      .object({
        name: id,
        title: z.string(),
        description: z.string().optional(),
        owner: z.string().optional(),
        locale: z.string().optional(),
        timezone: z.string().optional(),
        tags: z.record(z.string()).optional(),
      })
      .strict(),
    auth: z
      .object({
        provider: z.literal("cognito"),
        login: z.array(z.literal("email_password")).min(1),
        mfa: z.enum(["off", "optional", "required"]).optional(),
        self_signup: z.boolean().optional(),
        federation: z.array(z.unknown()).optional(),
        session: z.object({ idle_timeout_minutes: z.number().int().positive() }).strict().optional(),
      })
      .strict(),
    roles: z
      .array(z.object({ id, description: z.string().optional(), default: z.boolean().optional() }).strict())
      .min(1),
    entities: z.array(Entity).min(1),
    permissions: z.record(entityName, z.record(id, RolePermission)),
    audit: z.object({ enabled: z.boolean(), retention_days: z.number().int().optional() }).strict().optional(),
    pages: z
      .array(z.object({ id, title: z.string(), entity: entityName, filter: z.string().optional() }).strict())
      .optional(),
    seed: z.record(z.array(z.record(z.unknown()))).optional(),
    infra: z.record(z.unknown()).optional(),
    environments: z.record(id, Environment).refine((e) => "dev" in e, "a 'dev' environment is required"),
    verify: z.record(z.unknown()).optional(),
  })
  .strict();

export type Blueprint = z.infer<typeof Blueprint>;
export type Field = z.infer<typeof Field>;
