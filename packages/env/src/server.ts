import "dotenv/config";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  emptyStringAsUndefined: true,
  runtimeEnv: process.env,
  server: {
    CORS_ORIGIN: z.string().default("*"),
    DATABASE_URL: z.string().optional(),
    GROQ_API_KEY: z.string().min(1),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    WHISPER_MODEL: z.string().default("whisper-large-v3-turbo"),
  },
});
