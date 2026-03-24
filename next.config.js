/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  generateBuildId: async () => {
    // Force unique build ID to prevent Vercel from restoring stale compiled chunks
    return 'build-' + Date.now();
  },
}
module.exports = nextConfig
