#[cfg(test)]
#[path = "readiness_tests.rs"]
mod tests;
use crate::diagnostics::{push_with_timeout, Failure};
use rustpush::{PushError, ResourceState};
use std::{future::Future, time::Duration};

fn generated(stage: &'static str, state: &ResourceState) -> Result<(), Failure> {
    match state {
        ResourceState::Generated => Ok(()),
        ResourceState::Failed(error) => Err(Failure::push(stage, error.clone().into())),
        ResourceState::Generating | ResourceState::Closed => Err(Failure::new(stage, "not_ready")),
    }
}

pub async fn probe(
    apns: &ResourceState,
    registration: &ResourceState,
    ping: impl Future<Output = Result<(), PushError>>,
) -> Result<(), Failure> {
    generated("apns", apns)?;
    generated("registration", registration)?;
    push_with_timeout("apns", Duration::from_secs(2), ping).await
}
