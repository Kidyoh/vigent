//! vigent as one native binary (the Rust port, #168): a vim-native screen for
//! the coding-agent CLIs you have installed, each agent in its own riftri
//! worktree. PORTING.md maps every module to its TypeScript original and lists
//! what's left to port, by area.

// The port fills these modules in area by area; until then some of what they
// declare (the TypeScript vigent's whole shape) has no caller yet.
#![allow(dead_code)]

mod actions;
mod agents;
mod app;
mod cli;
mod commands;
mod config;
mod engines;
mod health;
mod help;
mod keys;
mod names;
mod records;
mod review;
mod serve;
mod session;
mod theme;
mod toml;
mod tui;
mod ui;
mod windows;
mod worktree;

fn main() {
    std::process::exit(cli::main(std::env::args().skip(1).collect()));
}
