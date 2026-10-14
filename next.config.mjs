/** @type {import('next').NextConfig} */
const nextConfig = { reactStrictMode: true, distDir: process.env.ENGRAM_BUILD_DIR || '.next', serverExternalPackages: ["falkordb"] };
export default nextConfig;
