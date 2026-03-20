import { app } from "../server.js";

// Forwards Vercel serverless requests into the existing Express routes.
export default function handler(req, res) {
  return app(req, res);
}

