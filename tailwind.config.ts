import type { Config } from "tailwindcss";
const config: Config = { content: ["./app/**/*.{js,ts,jsx,tsx,mdx}", "./components/**/*.{js,ts,jsx,tsx,mdx}"], theme: { extend: { colors: { ink: "#1d211e", paper: "#f6f5f1", ember: "#ed821a" }, fontFamily: { sans: ["Inter", "sans-serif"], mono: ["JetBrains Mono", "monospace"] } } }, plugins: [] };
export default config;
