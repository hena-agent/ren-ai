use super::*;
use rustpush::{ResourceFailure, ResourceState};
use std::sync::Arc;

#[tokio::test(start_paused = true)]
async fn cached_registration_is_not_ready_without_a_live_apple_connection() {
    async fn ping(result: Option<Result<(), PushError>>) -> Result<(), PushError> {
        match result {
            Some(result) => result,
            None => std::future::pending().await,
        }
    }
    assert!(probe(
        &ResourceState::Generated,
        &ResourceState::Generated,
        ping(Some(Ok(())))
    )
    .await
    .is_ok());
    for state in [
        ResourceState::Generating,
        ResourceState::Closed,
        ResourceState::Failed(ResourceFailure {
            retry_wait: None,
            error: Arc::new(PushError::APSAckError(7)),
        }),
    ] {
        assert_eq!(
            probe(&state, &ResourceState::Generated, ping(None))
                .await
                .unwrap_err()
                .stage,
            "apns"
        );
        assert_eq!(
            probe(&ResourceState::Generated, &state, ping(None))
                .await
                .unwrap_err()
                .stage,
            "registration"
        );
    }
    assert_eq!(
        probe(
            &ResourceState::Generated,
            &ResourceState::Generated,
            ping(None)
        )
        .await
        .unwrap_err()
        .cause["code"],
        "timeout"
    );
    assert_eq!(
        probe(
            &ResourceState::Generated,
            &ResourceState::Generated,
            ping(Some(Err(PushError::APSAckError(9))))
        )
        .await
        .unwrap_err()
        .cause["code"],
        9
    );
}
