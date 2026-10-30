import { readFileSync } from "node:fs";
import { validateBlueprintYaml } from "@owninfra/blueprint-schema";
import { appStack, newApp } from "./index.js";

const r = validateBlueprintYaml(readFileSync(new URL("../../../examples/approvals/blueprint.yaml", import.meta.url), "utf8"));
if (!r.ok) throw new Error(JSON.stringify(r.errors));
const app = newApp();
appStack(app, r.model, "dev");
app.synth();
