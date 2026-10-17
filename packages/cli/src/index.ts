import { readFile } from "node:fs/promises";
import { validateBlueprintYaml, type Issue } from "@owninfra/blueprint-schema";

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

const planned = ["init", "plan", "generate", "dev", "verify", "deploy", "destroy"] as const;

const usage = `Usage: owninfra <command> [options]

Commands:
  validate [file]   Validate a blueprint (default: blueprint.yaml)
${planned.map((c) => `  ${c.padEnd(16)}  not implemented yet`).join("\n")}
`;

export async function run(argv: string[], io: Io): Promise<number> {
  const [command, ...args] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    io.out(usage);
    return command ? 0 : 1;
  }
  if (command === "validate") return validate(args[0] ?? "blueprint.yaml", io);
  if ((planned as readonly string[]).includes(command)) {
    io.err(`owninfra ${command}: not implemented yet`);
    return 2;
  }
  io.err(`Unknown command '${command}'\n\n${usage}`);
  return 1;
}

async function validate(file: string, io: Io): Promise<number> {
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (e) {
    io.err(`Cannot read ${file}: ${(e as NodeJS.ErrnoException).code ?? String(e)}`);
    return 1;
  }
  const result = validateBlueprintYaml(source);
  const print = (kind: string, issues: Issue[], write: (l: string) => void) =>
    issues.forEach((i) => write(`${kind} ${i.path}: ${i.message}`));
  print("warning", result.warnings, io.err);
  if (!result.ok) {
    print("error", result.errors, io.err);
    io.err(`${file}: ${result.errors.length} error(s)`);
    return 1;
  }
  io.out(`${file}: valid`);
  return 0;
}
