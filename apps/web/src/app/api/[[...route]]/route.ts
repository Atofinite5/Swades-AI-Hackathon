import { handle } from "hono/vercel";
import app from "../../../../../../apps/server/dist/app.mjs";

// Force Node.js runtime — the Hono app uses node-postgres / dotenv / AWS SDK,
// none of which run on Vercel edge.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// biome-ignore lint/suspicious/noExplicitAny: bundled Hono instance has its own type identity
const handler = handle(app as any);

export {
  handler as GET,
  handler as POST,
  handler as PUT,
  handler as PATCH,
  handler as DELETE,
  handler as OPTIONS,
  handler as HEAD,
};
