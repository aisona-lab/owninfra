import { writeFileSync } from "node:fs";
import { zodToJsonSchema } from "zod-to-json-schema";
import { Blueprint } from "../dist/index.js";

const schema = zodToJsonSchema(Blueprint, { name: "Blueprint", $refStrategy: "none" });
writeFileSync(new URL("../blueprint.schema.json", import.meta.url), JSON.stringify(schema, null, 2) + "\n");
