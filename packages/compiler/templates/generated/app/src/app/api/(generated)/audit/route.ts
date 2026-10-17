import { handle } from "@/lib/(generated)/http";
import { auditLog } from "@/lib/(generated)/repository";

export async function GET() {
  return handle((user) => auditLog(user));
}
