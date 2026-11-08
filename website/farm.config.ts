import { defineConfig } from "@farm.js/core";
import { devtools } from "@farm.js/devtools";

export default defineConfig({
  plugins: [devtools()],
  theme: {
    default: "dark",
  },
  // `pnpm build` writes Vercel's prebuilt output (.vercel/output); `pnpm run deploy` uploads it
  deploy: {
    target: "vercel",
  },
});
