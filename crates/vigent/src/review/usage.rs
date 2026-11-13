//! Tokens and money, as :dash, :cost and the race window show them
//! (formatTokens, formatCost, formatUsage, totalUsage in src/app.ts).

use crate::session::Session;

/// "950 tok", "12.4k tok", "3.3M tok"
pub fn format_tokens(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M tok", js_round(n as f64 / 1_000_000.0, 1))
    } else if n >= 1000 {
        format!("{:.1}k tok", js_round(n as f64 / 1000.0, 1))
    } else {
        format!("{n} tok")
    }
}

/// US dollars: cents, or a tenth of a cent below one cent.
pub fn format_cost(usd: f64) -> String {
    if usd > 0.0 && usd < 0.01 { format!("${:.3}", js_round(usd, 3)) } else { format!("${:.2}", js_round(usd, 2)) }
}

/// JavaScript's toFixed rounds half away from zero on the decimal it prints; Rust's
/// formatter rounds half to even on the binary value. Close enough once nudged.
fn js_round(x: f64, places: i32) -> f64 {
    let m = 10f64.powi(places);
    (x * m + 1e-9_f64.copysign(x)).round() / m
}

/// "12.4k tok · $0.31", or just the tokens when the engine reports no price.
pub fn format_usage(tokens: u64, cost: Option<f64>) -> String {
    match cost {
        None => format_tokens(tokens),
        Some(c) => format!("{} · {}", format_tokens(tokens), format_cost(c)),
    }
}

/// Every agent's usage added up: (tokens, cost of the agents that report one, agents with tokens but no price).
pub fn total_usage(all: impl IntoIterator<Item = (u64, Option<f64>)>) -> (u64, Option<f64>, usize) {
    let (mut tokens, mut cost, mut unpriced) = (0, None, 0);
    for (t, c) in all {
        tokens += t;
        match c {
            None if t > 0 => unpriced += 1,
            None => {}
            Some(c) => cost = Some(cost.unwrap_or(0.0) + c),
        }
    }
    (tokens, cost, unpriced)
}

/// Engines that report a price with their usage (Claude Code's total_cost_usd,
/// OpenCode's step cost, pi's usage.cost); Codex, Gemini CLI and Cursor report none.
const PRICED: &[&str] = &["claude", "opencode", "pi"];

/// An agent's cost as TypeScript keeps it (`undefined` until the engine reports
/// one): Rust's Session adds reported costs into an f64, so an agent has a price
/// once it has one, or once an engine that prices its tokens has used some.
pub fn cost_of(s: &Session) -> Option<f64> {
    if s.cost > 0.0 || (s.tokens > 0 && PRICED.contains(&s.engine.as_str())) { Some(s.cost) } else { None }
}

/// formatUsage for an agent.
pub fn of(s: &Session) -> String {
    format_usage(s.tokens, cost_of(s))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formatting_tokens_money_both() {
        assert_eq!(format_tokens(950), "950 tok");
        assert_eq!(format_tokens(12_400), "12.4k tok");
        assert_eq!(format_tokens(3_250_000), "3.3M tok");
        assert_eq!(format_cost(0.251577), "$0.25");
        assert_eq!(format_cost(0.0042), "$0.004", "under a cent: a tenth of a cent");
        assert_eq!(format_cost(0.0), "$0.00");
        assert_eq!(format_usage(12_400, Some(0.31)), "12.4k tok · $0.31");
        assert_eq!(format_usage(12_400, None), "12.4k tok", "no price reported: no price shown");
        assert_eq!(total_usage([(10, Some(0.5)), (5, None), (0, None), (1, Some(0.25))]), (16, Some(0.75), 1));
        assert_eq!(total_usage([(5, None)]), (5, None, 1));
    }

    #[test]
    fn an_agent_has_a_price_once_its_engine_reports_one() {
        let mut s = Session::new(0, "a", "codex", "/x".into());
        s.tokens = 21_300;
        assert_eq!(of(&s), "21.3k tok");
        s.engine = "claude".into();
        s.tokens = 74_810;
        s.cost = 0.503154;
        assert_eq!(of(&s), "74.8k tok · $0.50");
        s.engine = "opencode".into();
        s.cost = 0.0;
        assert_eq!(of(&s), "74.8k tok · $0.00", "OpenCode prices each step (this model is free)");
    }
}
