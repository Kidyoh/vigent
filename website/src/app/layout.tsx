import type { LayoutProps, Metadata } from "@farm.js/core";
import "@fontsource-variable/jetbrains-mono";
import "./globals.css";
import { PAINT_SAVED_THEME } from "../lib/site-theme";

export const metadata: Metadata = {
  title: "vigent",
  description: "The vim-native agent harness: run Claude Code, Codex, OpenCode and pi in parallel, each in its own copy-on-write worktree.",
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml", sizes: "any" }],
  },
};

export default function RootLayout({ children }: LayoutProps) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#0a0a0b" />
        <script dangerouslySetInnerHTML={{ __html: PAINT_SAVED_THEME }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
