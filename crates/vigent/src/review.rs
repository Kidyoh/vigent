//! Review area: what an agent changed and landing it (src/review.ts,
//! src/hunks.ts, src/hunk-review.ts, src/diffview.ts; :diff, :review, :merge,
//! :pr, :w, the before_merge hook). Its state lives here, on App::review.

/// Review state on the App (add fields here, not to App).
#[derive(Default)]
pub struct Review {}
