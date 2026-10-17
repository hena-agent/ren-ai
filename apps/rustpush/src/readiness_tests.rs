use super::*;
use rustpush::ResourceFailure;
use std::sync::Arc;

async fn ping(result: Option<Result<(), PushError>>) -> Result<(), PushError> {
    match result {
        Some(result) => result,
        None => std::future::pending().await,
    }
}

async fn check(
    apns: ResourceState,
    registration: ResourceState,
    result: Option<Result<(), PushError>>,
) -> Result<(), Failure> {
    let (_apns, apns) = watch::channel(apns);
    let (_registration, registration) = watch::channel(registration);
    probe(apns, registration, ping(result)).await
}

#[tokio::test(start_paused = true)]
async fn cached_registration_is_not_ready_without_a_live_apple_connection() {
    assert!(check(
        ResourceState::Generated,
        ResourceState::Generated,
        Some(Ok(()))
    )
    .await
    .is_ok());
    for state in [
        ResourceState::Closed,
        ResourceState::Failed(ResourceFailure {
            retry_wait: None,
            error: Arc::new(PushError::APSAckError(7)),
        }),
    ] {
        assert_eq!(
            check(state.clone(), ResourceState::Generated, None)
                .await
                .unwrap_err()
                .stage,
            "apns"
        );
        assert_eq!(
            check(ResourceState::Generated, state, None)
                .await
                .unwrap_err()
                .stage,
            "registration"
        );
    }
    assert_eq!(
        check(ResourceState::Generated, ResourceState::Generated, None)
            .await
            .unwrap_err()
            .cause["code"],
        "timeout"
    );
    assert_eq!(
        check(
            ResourceState::Generated,
            ResourceState::Generated,
            Some(Err(PushError::APSAckError(9)))
        )
        .await
        .unwrap_err()
        .cause["code"],
        9
    );
    assert_eq!(
        check(ResourceState::Generating, ResourceState::Generated, None)
            .await
            .unwrap_err()
            .stage,
        "session"
    );
}

#[tokio::test(start_paused = true)]
async fn registration_renewal_can_finish_without_restarting_the_session() {
    let (_apns, apns) = watch::channel(ResourceState::Generated);
    let (registration, updates) = watch::channel(ResourceState::Generating);
    let probe = probe(apns.clone(), updates.clone(), ping(Some(Ok(()))));
    tokio::pin!(probe);
    tokio::select! {
        _ = &mut probe => panic!("registration must finish before readiness"),
        _ = tokio::time::sleep(Duration::from_secs(1)) => {},
    }
    registration.send_replace(ResourceState::Generated);
    assert!(probe.await.is_ok());
    registration.send_replace(ResourceState::Generating);
    drop(registration);
    assert_eq!(
        super::probe(apns, updates, ping(None))
            .await
            .unwrap_err()
            .cause["code"],
        "state_closed"
    );
}
