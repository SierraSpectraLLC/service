/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    // Evaluated once at build time; Vercel injects VERCEL_GIT_COMMIT_SHA.
    NEXT_PUBLIC_BUILD_SHA: (process.env.VERCEL_GIT_COMMIT_SHA || "dev").slice(0, 7),
    NEXT_PUBLIC_BUILD_TIME: new Date().toISOString(),
  },
};
export default nextConfig;
