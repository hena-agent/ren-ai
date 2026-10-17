use std::process::Command;

fn events(
    args: &[&str],
    state: Option<&std::path::Path>,
) -> (bool, Vec<u8>, Vec<serde_json::Value>, String) {
    let mut command = Command::new(env!("CARGO_BIN_EXE_ren-rustpush"));
    command.args(args).env_remove("RUSTPUSH_STATE_DIR");
    if let Some(state) = state {
        command.env("RUSTPUSH_STATE_DIR", state);
    }
    let output = command.output().unwrap();
    let stderr = String::from_utf8(output.stderr).unwrap();
    let events = stderr
        .lines()
        .filter(|line| line.starts_with('{'))
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    (output.status.success(), output.stdout, events, stderr)
}

#[test]
fn failures_are_correlated_at_the_process_boundary_without_echoing_private_inputs() {
    let state = std::env::temp_dir()
        .join("opencode")
        .join(format!("ren-rustpush-cli-{}", uuid::Uuid::new_v4()));
    let (success, stdout, events, stderr) =
        events(&["rpc", "mailto:private-sender@example.test"], Some(&state));
    assert!(!success);
    assert!(stdout.is_empty());
    assert!(!stderr.contains("example.test"));
    assert_eq!(events.len(), 2);
    assert_eq!(events[0]["stage"], "identity");
    assert_eq!(events[0]["cause"]["code"], "run_login_first");
    assert_eq!(events[1]["stage"], "complete");
    assert_eq!(events[0]["request_id"], events[1]["request_id"]);
    assert!(uuid::Uuid::parse_str(events[0]["request_id"].as_str().unwrap()).is_ok());
    assert!(events[0]["duration_ms"].is_number());
    std::fs::remove_dir_all(state).unwrap();
}

#[test]
fn the_bridge_requires_an_explicit_command_service_handle_and_state() {
    for args in [&["send"][..], &["rpc"], &["rpc", "tel:+15550100"], &[]] {
        let (success, stdout, events, stderr) = events(args, None);
        assert!(!success && stdout.is_empty());
        assert!(stderr.contains("Usage: ren-rustpush"));
        assert_eq!(events[0]["cause"]["code"], "invalid_command");
        assert_eq!(
            events[0]["operation"],
            if args.first() == Some(&"rpc") {
                "rpc"
            } else {
                "usage"
            }
        );
    }
    let (success, _, events, _) = events(&["rpc", "mailto:service@example.test"], None);
    assert!(!success);
    assert_eq!(events[0]["cause"]["code"], "rustpush_state_dir_required");
}
