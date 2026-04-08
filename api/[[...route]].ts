import { handle } from "hono/vercel";
// @ts-expect-error - built artifact, present at runtime via includeFiles
import app from "../apps/server/dist/app.mjs";

export const config = {
  api: {
    bodyParser: false,
  },
};

export default handle(app);
