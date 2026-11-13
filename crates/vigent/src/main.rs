//! vigent as one native binary (the Rust port, #168): a vim-native screen for
//! the coding-agent CLIs you have installed, each agent in its own riftri
//! worktree. PORTING.md maps every module to its TypeScript original and lists
//! what's left to port, by area.

// The port fills these modules in area by area; until then some of what they
// declare (the TypeScript vigent's whole shape) has no caller yet.
#![allow(dead_code)]

mod actions;
mod app;
mod cli;
mod color;
mod commands;
mod config;
mod config_edit;
mod demo;
mod engines;
mod follow;
mod health;
mod help;
mod import;
mod keys;
mod layout;
mod looks;
mod names;
mod permissions;
mod records;
mod review;
mod serve;
mod session;
mod settings;
mod style;
mod suggest;
mod templates;
mod theme;
mod themecli;
mod toml;
mod trust;
mod tui;
mod ui;
mod usercmd;
mod vimcolors;
mod windows;
mod worktree;

fn main() {
    std::process::exit(cli::main(std::env::args().skip(1).collect()));
}
