//! Serve area: following your agents from your phone (src/serve.ts,
//! src/serve-page.ts: :serve, vigent --serve), with std's TcpListener (no
//! async runtime). Its state lives here, on App::serve.

/// Server state on the App (add fields here, not to App).
#[derive(Default)]
pub struct Serve {}
