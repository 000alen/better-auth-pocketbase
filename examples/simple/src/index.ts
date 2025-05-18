import "dotenv/config";

import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { auth } from "../lib/auth.js";

const app = new Hono();

app.use(cors());

app.on(["POST", "GET"], "/api/auth/**", (c) => auth.handler(c.req.raw));

serve(app);
