import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  // DDL should use Neon's direct (unpooled) connection when available;
  // the pooled URL is for the app's runtime queries.
  dbCredentials: { url: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL! },
  // Print every statement push executes - build logs then show exactly what
  // changed (or what failed).
  verbose: true,
});
