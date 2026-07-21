import { execSync } from "node:child_process";
import { PHASE_PRODUCTION_BUILD } from "next/constants.js";

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    // Evaluated once at build time; Vercel injects VERCEL_GIT_COMMIT_SHA.
    NEXT_PUBLIC_BUILD_SHA: (process.env.VERCEL_GIT_COMMIT_SHA || "dev").slice(0, 7),
    NEXT_PUBLIC_BUILD_TIME: new Date().toISOString(),
  },
};

export default function config(phase) {
  // Sync the database schema during every Vercel production build. Hooked here
  // (not in a package script) so it runs no matter how the build is invoked -
  // dashboard build-command overrides and the framework preset both end up
  // evaluating next.config. Guarded by an env flag because build workers
  // re-evaluate the config; they inherit the flag and skip.
  if (phase === PHASE_PRODUCTION_BUILD && process.env.VERCEL && !process.env.__SCHEMA_PUSH_DONE) {
    process.env.__SCHEMA_PUSH_DONE = "1";
    // Apply the idempotent, additive schema sync (never destructive, so it
    // can't hit drizzle-kit push's spurious-diff rollback), then independently
    // verify every table/column the app needs actually exists. The verify step
    // is what gates the build - it throws and fails the deploy on any gap.
    execSync("npx tsx scripts/sync-schema.ts", { stdio: "inherit" });
    execSync("npx tsx scripts/verify-schema.ts", { stdio: "inherit" });
  }
  return nextConfig;
}
