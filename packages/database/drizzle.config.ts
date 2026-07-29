import { defineConfig } from "drizzle-kit";

const url = process.env["DATABASE_MIGRATION_URL"];
if (!url) throw new Error("DATABASE_MIGRATION_URL is required for Drizzle commands");

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
