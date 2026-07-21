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
    console.log("[schema] syncing database schema (drizzle-kit push)...");
    // drizzle-kit can print an error yet still exit 0, so its exit code alone
    // proves nothing. Run it, surface its output, then independently verify
    // that every table/column the app's schema defines actually exists -
    // that check is what gates the build.
    try {
      execSync("npx drizzle-kit push", { stdio: "inherit" });
    } catch {
      console.error("[schema] drizzle-kit push exited nonzero - verifying what actually applied...");
    }
    execSync("npx tsx scripts/verify-schema.ts", { stdio: "inherit" }); // throws -> build fails loudly
  }
  return nextConfig;
}
