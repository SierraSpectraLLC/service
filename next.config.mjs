import { execSync } from "node:child_process";
import { PHASE_PRODUCTION_BUILD } from "next/constants.js";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // PGlite ships its own wasm and reads it off disk; bundling breaks that.
  // Only the dev:local harness (LOCAL_DB=1) ever loads it - see src/db/index.ts.
  serverExternalPackages: ["@electric-sql/pglite"],
  // The document layouts in templates/ are read off disk at request time -
  // the Excel workbooks by the /api/export routes, the service report's mark
  // by the report's own route. Serverless bundling only traces what code
  // imports, so each file must be named here or the deployed function finds
  // an empty directory where the layouts should be. A report that quietly
  // printed the operator's name where the logo belongs is what this prevents.
  outputFileTracingIncludes: {
    "/api/export/invoice/[id]": ["./templates/InvoiceTemplate.xlsx"],
    "/api/export/quote/[id]": ["./templates/QuoteTemplate.xlsx"],
    "/api/export/po/[id]": ["./templates/POTemplate.xlsx"],
    "/api/doc/service-report/[id]": ["./templates/ServiceReportLogo.png"],
  },
  env: {
    // Evaluated once at build time; Vercel injects VERCEL_GIT_COMMIT_SHA.
    NEXT_PUBLIC_BUILD_SHA: (process.env.VERCEL_GIT_COMMIT_SHA || "dev").slice(0, 7),
    NEXT_PUBLIC_BUILD_TIME: new Date().toISOString(),
  },
  // Purchasing, reimbursements and payroll moved under /money when the five
  // money nav entries became one Financial section. Bookmarks and emailed
  // links exist - a digest sent last month links straight at an expense
  // report - so the old paths are permanent redirects rather than 404s.
  // Sub-paths come along: /expenses/12 is somebody's report.
  async redirects() {
    return [
      { source: "/purchasing", destination: "/money/purchasing", permanent: true },
      { source: "/purchasing/:path*", destination: "/money/purchasing/:path*", permanent: true },
      { source: "/expenses", destination: "/money/reimbursements", permanent: true },
      { source: "/expenses/:path*", destination: "/money/reimbursements/:path*", permanent: true },
      { source: "/payroll", destination: "/money/payroll", permanent: true },
      { source: "/payroll/:path*", destination: "/money/payroll/:path*", permanent: true },
    ];
  },
};

export default function config(phase) {
  // Sync the database schema during every Vercel PRODUCTION build. Hooked here
  // (not in a package script) so it runs no matter how the build is invoked -
  // dashboard build-command overrides and the framework preset both end up
  // evaluating next.config. Guarded by an env flag because build workers
  // re-evaluate the config; they inherit the flag and skip.
  //
  // Production deployments only. PHASE_PRODUCTION_BUILD is `next build` in
  // every environment, previews included, and a preview build that reaches
  // the production database rewrites its schema for code that is not
  // deployed: a branch that swapped the EOD unique constraints was built as
  // a preview and every EOD save on the live code was refused from then on.
  // The preview itself is not gated either - a preview that needs a column
  // production lacks was never going to work against production data.
  if (phase === PHASE_PRODUCTION_BUILD && process.env.VERCEL && !process.env.__SCHEMA_PUSH_DONE) {
    if (process.env.VERCEL_ENV !== "production") {
      console.log(`[schema] ${process.env.VERCEL_ENV || "non-production"} build - schema sync skipped; only a production build touches the database`);
      return nextConfig;
    }
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
