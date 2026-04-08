import { handle } from "hono/vercel";
import app from "../src/app";

export const config = {
  api: {
    bodyParser: false, // Hono handles body parsing
  },
};

export default handle(app);
