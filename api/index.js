import app from "../server.js";

// Vercel Node Serverless Function entrypoint.
// Exporting the Express app lets Vercel handle req/res without app.listen().
export const config = {
  maxDuration: 300,
};

export default app;

