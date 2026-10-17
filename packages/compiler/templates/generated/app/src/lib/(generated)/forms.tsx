"use client";
import { useActionState } from "react";
import type { FormState } from "./actions";
import type { Column } from "./types";

export type Option = { value: string; label: string };

function Input({ c, options, value, invalid }: { c: Column; options: Option[] | undefined; value: string | undefined; invalid: boolean }) {
  const common = { id: `f-${c.name}`, name: c.name, required: c.required, "aria-invalid": invalid || undefined, "aria-describedby": invalid ? `e-${c.name}` : undefined };
  const initial = value ?? (c.default === null ? undefined : String(c.default));
  if (c.input === "bool") return <input {...common} type="checkbox" required={false} defaultChecked={value === undefined ? c.default === true : value === "on"} />;
  if (c.input === "enum" || c.input === "ref") {
    const choices = c.input === "enum" ? (c.values ?? []).map((v) => ({ value: v, label: v })) : (options ?? []);
    return (
      <select {...common} defaultValue={initial ?? ""}>
        {c.required && initial ? null : <option value="">{c.required ? "Choose…" : "—"}</option>}
        {choices.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  if (c.input === "text") return <textarea {...common} defaultValue={initial} />;
  const type = { int: "number", date: "date", datetime: "datetime-local", email: "email" }[c.input as string] ?? "text";
  return <input {...common} type={type} inputMode={c.input === "decimal" ? "decimal" : undefined} defaultValue={initial} />;
}

export function EntityForm({
  action,
  columns,
  options = {},
  title,
  submit,
}: {
  action: (state: FormState, form: FormData) => Promise<FormState>;
  columns: Column[];
  options?: Record<string, Option[]>;
  title?: string;
  submit: string;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const errors = state?.errors ?? {};
  return (
    <form action={formAction} className="form" noValidate>
      {title ? <h2>{title}</h2> : null}
      {errors[""] ? (
        <p role="alert" className="error">
          {errors[""]}
        </p>
      ) : null}
      <div key={JSON.stringify(state)} className="fields">
        {columns.map((c) => (
          <div key={c.name} className="field">
            <label htmlFor={`f-${c.name}`}>
              {c.label}
              {c.input === "datetime" ? " (UTC)" : ""}
              {c.required ? (
                <abbr className="req" title="required">
                  *
                </abbr>
              ) : null}
            </label>
            <Input c={c} options={options[c.name]} value={state?.values[c.name]} invalid={c.name in errors} />
            {errors[c.name] ? (
              <span id={`e-${c.name}`} className="error">
                {c.label} {errors[c.name]}
              </span>
            ) : null}
          </div>
        ))}
      </div>
      <button type="submit" disabled={pending}>
        {submit}
      </button>
    </form>
  );
}
