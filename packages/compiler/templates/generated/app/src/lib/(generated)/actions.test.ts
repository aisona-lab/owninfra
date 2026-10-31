import { describe, expect, it, vi } from "vitest";
import { createAction, transitionAction } from "./actions";
import { Unavailable, startingUp, unknownOutcome } from "./errors";
import { registry } from "./registry";

const repo = vi.hoisted(() => ({ create: vi.fn(), transition: vi.fn() }));
vi.mock("./repository", () => repo);
vi.mock("./session", () => ({ requireUser: async () => ({ email: "admin@example.test", roles: ["admin"] }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("NEXT_REDIRECT");
  },
}));

const withWorkflow = registry.entities.find((e) => e.workflow);

describe("form actions show a 503 as the form's message", () => {
  it.each([startingUp, unknownOutcome])("create: %s", async (message) => {
    repo.create.mockRejectedValue(new Unavailable(message, 5));
    expect(await createAction(registry.entities[0].table, null, new FormData())).toEqual({ errors: { "": message }, values: {} });
  });

  it.runIf(withWorkflow).each([startingUp, unknownOutcome])("transition: %s", async (message) => {
    repo.transition.mockRejectedValue(new Unavailable(message));
    const t = withWorkflow!.workflow!.transitions[0];
    expect(await transitionAction(withWorkflow!.table, "00000000-0000-0000-0000-000000000000", t.id, null, new FormData())).toEqual({ errors: { "": message }, values: {} });
  });
});
