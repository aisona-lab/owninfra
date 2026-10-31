export const generatedFiles: ReadonlySet<string> = new Set([
  ".gitattributes",
  "docker-compose.yml",
  "app/.gitignore",
  "app/eslint.config.mjs",
  "app/next.config.mjs",
  "app/package-lock.json",
  "app/package.json",
  "app/scripts/check-deps.mjs",
  "app/scripts/dev-db.mjs",
  "app/src/app/api/auth/[...nextauth]/route.ts",
  "app/src/app/favicon.ico/route.ts",
  "app/src/app/layout.tsx",
  "app/src/auth.ts",
  "app/src/lib/owninfra/index.ts",
  "app/src/next-auth.d.ts",
  "app/tsconfig.json",
  "app/vitest.config.mts",
]);

const generatedDirs = ["app/drizzle/"];
const userPrefixes = ["app/src/custom/", "app/src/app/(custom)/"];

const insideGeneratedGroup = (path: string) => {
  const parts = path.split("/");
  const i = parts.indexOf("(generated)");
  return path.startsWith("app/src/") && i >= 0 && i < parts.length - 1;
};

export function isGeneratedPath(path: string): boolean {
  if (path.split("/").some((s) => s === "" || s === "." || s === "..") || isUserPath(path)) return false;
  return generatedFiles.has(path) || generatedDirs.some((d) => path.startsWith(d) && path.length > d.length) || insideGeneratedGroup(path);
}

export const isUserPath = (path: string) => userPrefixes.some((p) => path.startsWith(p) && path.length > p.length);
