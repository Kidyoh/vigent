//! Tokens and money, as :dash, :cost and the race window show them. The
//! formatting (formatTokens, formatCost, formatUsage, totalUsage in
//! src/app.ts) is session.rs'; an agent's cost is `None` until its engine
//! reports one, as TypeScript's `cost?: number`.

pub use crate::session::{format_cost, format_tokens, format_usage, total_usage};
use crate::session::Session;

/// formatUsage for an agent.
pub fn of(s: &Session) -> String {
    format_usage(s.tokens, s.cost)
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
        let agent = |tokens: u64, cost: Option<f64>| {
            let mut s = Session::new(0, "a", "claude", "/x".into());
            (s.tokens, s.cost) = (tokens, cost);
            s
        };
        let all = [agent(10, Some(0.5)), agent(5, None), agent(0, None), agent(1, Some(0.25))];
        assert_eq!(total_usage(all.iter()), (16, Some(0.75), 1));
        assert_eq!(total_usage([agent(5, None)].iter()), (5, None, 1));
    }

    #[test]
    fn an_agent_has_a_price_once_its_engine_reports_one() {
        let mut s = Session::new(0, "a", "codex", "/x".into());
        s.tokens = 21_300;
        assert_eq!(of(&s), "21.3k tok");
        s.engine = "claude".into();
        s.tokens = 74_810;
        s.cost = Some(0.503154);
        assert_eq!(of(&s), "74.8k tok · $0.50");
        s.engine = "opencode".into();
        s.cost = Some(0.0);
        assert_eq!(of(&s), "74.8k tok · $0.00", "OpenCode prices each step (this model is free)");
    }
}
