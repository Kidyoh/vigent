# vigent website

The site for vigent, built with [Farm.js](https://farmjs.dev). It looks like a Neovim buffer: a tabline on top, numbered lines, a statusline, and a `:` command line (`j`/`k` scroll, `gg`/`G` jump, `yy` copies the install command).

```bash
cd website
pnpm install
pnpm dev        # local dev server
pnpm build      # production build in .farm/.output
pnpm start      # serve the build
```

- `src/app/page.tsx`: the home page (`/`)
- `src/app/docs/page.tsx`: the docs (`/docs`), with the help index on the side
- `src/components/`: the buffer lines, tabline, the text drawing of vigent, and `vim-chrome.tsx` (the statusline, command line and keys; the only code that runs in the browser)
- `src/lib/site.ts`: the version, install command and other facts shown in several places
- `src/app/globals.css`: all styles

Both pages render statically at build time. Every page also answers as Markdown at its URL plus `.md`.
