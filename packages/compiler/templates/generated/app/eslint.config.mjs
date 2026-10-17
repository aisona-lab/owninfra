import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["scripts/**/*.mjs", "*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly", URL: "readonly" } },
  },
  {
    files: ["src/custom/**", "src/app/(custom)/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["**/(generated)/**", "postgres", "drizzle-orm", "drizzle-orm/**"], message: "Import from @/lib/owninfra. Its repository functions are guarded and audited." },
          ],
        },
      ],
    },
  },
);
