import { defineConfig } from "vitest/config";
// Test files share one Postgres and truncate tables: run them one at a time.
export default defineConfig({ test: { fileParallelism: false } });
