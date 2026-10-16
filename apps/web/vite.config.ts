import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

// Build-only: the dev server injects inline styles and scripts for HMR.
// frame-ancestors cannot be set from a meta tag, so the reverse proxy sends it.
function contentSecurityPolicy(api: string): Plugin {
  const ws = api.replace(/^http/, "ws");
  const policy = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    `connect-src 'self' ${api} ${ws}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  return {
    name: "content-security-policy",
    apply: "build",
    transformIndexHtml: (html) =>
      html.replace(
        "<head>",
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`,
      ),
  };
}

export default defineConfig(({ mode }) => {
  const api = loadEnv(mode, process.cwd()).VITE_API ?? "http://localhost:8080";
  return { plugins: [react(), contentSecurityPolicy(api)] };
});
