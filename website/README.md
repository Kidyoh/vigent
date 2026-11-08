# vigent website

The site for vigent, built with [Farm.js](https://farmjs.dev). It looks like a Neovim buffer: a tabline on top, numbered lines, a statusline, and a `:` command line (`j`/`k` scroll, `gg`/`G` jump, `yy` copies the install command).

```bash
cd website
pnpm install
pnpm dev          # dev server with reload: http://localhost:3000
pnpm preview      # the production build, served locally: http://localhost:3000
pnpm build        # the Vercel build in .vercel/output (what production runs)
```

Needs Node 22.13 or newer and pnpm. `pnpm build` writes Vercel's output, so use `pnpm preview` (or `pnpm build:node` then `pnpm start`) to run a build locally. Pushes to `main` deploy to https://vigent.farming-labs.dev.

- `src/app/page.tsx`: the home page (`/`)
- `src/app/docs/page.tsx`: the docs (`/docs`), with the help index on the side
- `src/components/`: the buffer lines, tabline, the text drawing of vigent, and `vim-chrome.tsx` (the statusline, command line and keys; the only code that runs in the browser)
- `src/lib/site.ts`: the version, install command and other facts shown in several places
- `src/app/globals.css`: all styles

Both pages render statically at build time. Every page also answers as Markdown at its URL plus `.md`.
