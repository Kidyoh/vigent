/** Facts the site shows in more than one place. */
export const VERSION = "0.2.3";
export const INSTALL = "npm i -g @vigent/cli";
export const REPO = "https://github.com/farming-labs/vigent";

export const LOGO = [
  "██╗   ██╗██╗ ██████╗ ███████╗███╗   ██╗████████╗",
  "██║   ██║██║██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝",
  "██║   ██║██║██║  ███╗█████╗  ██╔██╗ ██║   ██║",
  "╚██╗ ██╔╝██║██║   ██║██╔══╝  ██║╚██╗██║   ██║",
  " ╚████╔╝ ██║╚██████╔╝███████╗██║ ╚████║   ██║",
  "  ╚═══╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝",
].join("\n");

/** A few of the 25 built-in colorschemes: background, then three accents. */
export const SWATCHES: [string, string[]][] = [
  ["tokyonight", ["#1a1b26", "#7aa2f7", "#bb9af7", "#9ece6a"]],
  ["catppuccin", ["#1e1e2e", "#cba6f7", "#89b4fa", "#a6e3a1"]],
  ["gruvbox", ["#282828", "#fabd2f", "#83a598", "#b8bb26"]],
  ["rose-pine", ["#191724", "#ebbcba", "#9ccfd8", "#c4a7e7"]],
  ["kanagawa", ["#1f1f28", "#7e9cd8", "#98bb6c", "#e6c384"]],
  ["nord", ["#2e3440", "#88c0d0", "#b48ead", "#a3be8c"]],
];
