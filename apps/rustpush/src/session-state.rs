use crate::{diagnostics::Failure, store::Store};
use serde::{de::DeserializeOwned, Serialize};
use std::future::Future;
use tokio::sync::mpsc;

pub fn restore<T: DeserializeOwned>(store: &Store, login: bool) -> Result<Option<T>, Failure> {
    let existing = store.load("identity.plist")?;
    if existing.is_none() && !login {
        return Err(Failure::new("identity", "run_login_first"));
    }
    Ok(existing)
}

pub async fn initialize<T: Serialize>(
    store: &Store,
    existing: Option<T>,
    create: impl Future<Output = Result<T, Failure>>,
) -> Result<T, Failure> {
    if let Some(existing) = existing {
        return Ok(existing);
    }
    let created = create.await?;
    store.save("identity.plist", &created)?;
    Ok(created)
}

/// Called synchronously before upstream acknowledges APNs. A failed save must stop the caller.
pub fn notification<T: Serialize>(
    store: &Store,
    notification: &T,
    notify: &mpsc::UnboundedSender<String>,
) -> Result<(), Failure> {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock predates Unix epoch")
        .as_nanos();
    let name = format!("inbox-{timestamp:020}-{}.plist", uuid::Uuid::new_v4());
    store.save(&name, notification)?;
    // A disconnected consumer leaves the durable file for the next process.
    let _ = notify.send(name);
    Ok(())
}

pub fn validation(bytes: &[u8]) -> Result<(), Failure> {
    if bytes.is_empty() {
        Err(Failure::new("validation", "empty_validation_data"))
    } else {
        Ok(())
    }
}

#[cfg(test)]
#[path = "session_state_tests.rs"]
mod tests;
