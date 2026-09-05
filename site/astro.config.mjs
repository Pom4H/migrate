import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://pom4h.github.io",
  base: "/migrate",
  output: "static",
  trailingSlash: "always",
});
