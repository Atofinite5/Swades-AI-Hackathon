import { env } from "@my-better-t-app/env/server";
import { drizzle } from "drizzle-orm/node-postgres";

import * as schema from "./schema";

export * from "./schema";

export function createDb() {
  const url = env.DATABASE_URL ?? "postgresql://postgres:password@localhost:5432/my-better-t-app";
  return drizzle(url, { schema });
}

export const db = createDb();
