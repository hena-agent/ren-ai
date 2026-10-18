use super::*;

#[test]
fn explicit_commands_and_registered_service_handles_are_required() {
    for (args, expected) in [
        (vec!["preflight"], Command::Preflight),
        (vec!["login"], Command::Login),
        (
            vec!["rpc", "mailto:hi@renai.im"],
            Command::Rpc("mailto:hi@renai.im".into()),
        ),
    ] {
        assert_eq!(
            parse(&args.into_iter().map(String::from).collect::<Vec<_>>()).unwrap(),
            expected
        );
    }
    for args in [
        vec![],
        vec!["unknown"],
        vec!["rpc"],
        vec!["rpc", "tel:+1555"],
        vec!["rpc", "mailto:personal@example.test"],
        vec!["rpc", "mailto:noti@renai.im"],
        vec!["login", "extra"],
    ] {
        assert_eq!(
            parse(&args.into_iter().map(String::from).collect::<Vec<_>>())
                .unwrap_err()
                .cause["code"],
            "invalid_command"
        );
    }
    assert!(require_handle("service", &["service".into()]).is_ok());
    assert_eq!(
        require_handle("service", &["other".into()])
            .unwrap_err()
            .cause["code"],
        "service_handle_not_registered"
    );
}
