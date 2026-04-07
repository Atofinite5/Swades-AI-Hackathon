import { env } from "@my-better-t-app/env/server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { chunksApp } from "./chunks";
import { transcribeApp } from "./transcribe";

const app = new Hono();

app.use(logger());
app.use(
  "/*",
  cors({
    allowMethods: ["GET", "POST", "OPTIONS"],
    origin: env.CORS_ORIGIN,
  }),
);

app.get("/", (c) => c.text("OK"));

app.route("/transcribe", transcribeApp);
app.route("/api/chunks", chunksApp);

const port = Number(process.env.PORT) || 3000;

console.log(` Server running on port ${port}`);

export default {
  fetch: app.fetch,
  port,
};
