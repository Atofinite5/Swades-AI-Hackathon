import app from "./app";

const port = Number(process.env.PORT) || 3000;

console.log(` Server running on port ${port}`);

export default {
  fetch: app.fetch,
  port,
};
