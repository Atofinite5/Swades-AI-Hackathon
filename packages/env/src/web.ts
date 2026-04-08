import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  client: {
    // Empty string = same-origin (API routes mounted on the same Next.js app).
    NEXT_PUBLIC_SERVER_URL: z.string().default(""),
  },
  emptyStringAsUndefined: false,
  runtimeEnv: {
    NEXT_PUBLIC_SERVER_URL: process.env.NEXT_PUBLIC_SERVER_URL,
  },
});
