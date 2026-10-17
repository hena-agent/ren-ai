#[cfg(test)]
#[path = "readiness_tests.rs"]
mod tests;
use crate::diagnostics::{push_with_timeout, Failure};
use rustpush::{PushError, ResourceState};
use std::{future::Future, time::Duration};
use tokio::sync::watch;

async fn generated(
    stage: &'static str,
    mut states: watch::Receiver<ResourceState>,
) -> Result<(), Failure> {
    let state = states
        .wait_for(|state| !matches!(state, ResourceState::Generating))
        .await
        .map_err(|_| Failure::new(stage, "state_closed"))?;
    match &*state {
        ResourceState::Generated => Ok(()),
        ResourceState::Failed(error) => Err(Failure::push(stage, error.clone().into())),
        ResourceState::Generating | ResourceState::Closed => Err(Failure::new(stage, "not_ready")),
    }
}

pub async fn probe(
    apns: watch::Receiver<ResourceState>,
    registration: watch::Receiver<ResourceState>,
    ping: impl Future<Output = Result<(), PushError>>,
) -> Result<(), Failure> {
    tokio::time::timeout(Duration::from_secs(60), async {
        generated("apns", apns).await?;
        generated("registration", registration).await
    })
    .await
    .map_err(|_| Failure::new("session", "timeout"))??;
    push_with_timeout("apns", Duration::from_secs(2), ping).await
}
