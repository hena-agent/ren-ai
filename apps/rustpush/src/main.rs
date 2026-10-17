#[cfg(test)]
mod apns_tests;
mod codec;
mod command;
mod delivery;
mod diagnostics;
mod io;
// Upstream IOKit hardware reader, compiled unmodified; it is not owned code.
#[allow(dead_code)]
#[rustfmt::skip]
#[path = "../../../node_modules/.cache/ren-rustpush/matrix/pkg/rustpushgo/src/local_config.rs"]
mod local_config;
#[path = "apple-transport.rs"]
mod native;
mod readiness;
mod rpc;
#[path = "apple-session.rs"]
mod session;
#[path = "session-state.rs"]
mod session_state;
mod store;

use diagnostics::Failure;
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

fn main() {
    // Upstream caches and anisette state are created by libraries that do not set modes.
    // SAFETY: called before any thread exists; umask only changes this process's file modes.
    unsafe { libc::umask(0o077) };
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("create bridge runtime")
        .block_on(start());
}

async fn start() {
    let request_id = uuid::Uuid::new_v4().to_string();
    let panic_request_id = request_id.clone();
    std::panic::set_hook(Box::new(move |panic| {
        // Upstream panic payloads can contain decoded messages or credentials.
        eprintln!(
            "{}",
            serde_json::json!({
                "level": "error", "request_id": panic_request_id,
                "operation": "rustpush_runtime", "stage": "panic", "outcome": "failure",
                "cause": "upstream_or_runtime_panic",
                "location": panic.location().map(|location| location.to_string()),
                "stack": std::backtrace::Backtrace::force_capture().to_string().chars().take(16384).collect::<String>(),
            })
        );
        std::process::exit(70);
    }));
    let started = Instant::now();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let operation = args
        .first()
        .map(String::as_str)
        .filter(|command| ["preflight", "login", "rpc"].contains(command))
        .unwrap_or("usage");
    let result = run(&args, &request_id).await;
    let event = serde_json::json!({
        "level": if result.is_ok() { "info" } else { "error" },
        "request_id": request_id, "operation": operation, "stage": "complete",
        "outcome": if result.is_ok() { "success" } else { "failure" },
        "duration_ms": started.elapsed().as_millis(),
    });
    if let Err(error) = result {
        eprintln!(
            "{}",
            serde_json::json!({
                "level": "error", "request_id": request_id, "operation": operation,
                "stage": error.stage, "cause": error.cause,
                "outcome": "failure", "duration_ms": started.elapsed().as_millis(),
            })
        );
        eprintln!("{event}");
        std::process::exit(1);
    }
    // stdout belongs to the RPC protocol; lifecycle events go to stderr.
    eprintln!("{event}");
    std::process::exit(0);
}

async fn run(args: &[String], request_id: &str) -> Result<(), Failure> {
    let command = command::parse(args).inspect_err(|_| {
        eprintln!("Usage: ren-rustpush preflight | login | rpc mailto:SERVICE_HANDLE")
    })?;
    let path = std::env::var_os("RUSTPUSH_STATE_DIR")
        .map(PathBuf::from)
        .ok_or_else(|| Failure::new("arguments", "rustpush_state_dir_required"))?;
    let store = Arc::new(store::Store::open(path)?);
    if command == command::Command::Preflight {
        let (_connection, config, _inbox) = session::connect(store, request_id).await?;
        let validation = diagnostics::push_with_timeout(
            "validation",
            Duration::from_secs(60),
            config.generate_validation_data(),
        )
        .await?;
        return session_state::validation(&validation);
    }
    let session =
        session::Session::open(store, command == command::Command::Login, request_id).await?;
    session
        .store
        .save("push.plist", &*session.connection.state.read().await)?;
    let command::Command::Rpc(handle) = command else {
        return Ok(());
    };
    let native = native::Apple {
        client: session.client,
        connection: session.connection,
    };
    command::require_handle(&handle, &rpc::Native::handles(&native).await?)?;
    let input = tokio::io::BufReader::new(tokio::io::stdin());
    let state = rpc::Session {
        native: Arc::new(native),
        store: session.store,
        handle: handle.clone(),
        pending: session.pending,
        inbox: session.inbox,
    };
    rpc::serve(state, input, tokio::io::stdout(), rpc::TIMING, request_id).await;
    Ok(())
}
