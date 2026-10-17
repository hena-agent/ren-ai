use super::*;
use crate::store::tests::fixture;
use std::sync::atomic::{AtomicUsize, Ordering};

async fn create(calls: &AtomicUsize, result: Result<String, Failure>) -> Result<String, Failure> {
    calls.fetch_add(1, Ordering::Relaxed);
    result
}

#[tokio::test]
async fn identity_restoration_never_silently_reauthenticates_or_replaces_existing_keys() {
    let (store, path) = fixture();
    let calls = AtomicUsize::new(0);
    assert_eq!(
        restore::<String>(&store, false).unwrap_err().cause["code"],
        "run_login_first"
    );
    assert!(restore::<String>(&store, true).unwrap().is_none());
    let rejected = initialize::<String>(
        &store,
        None,
        create(&calls, Err(Failure::new("login", "rejected"))),
    )
    .await;
    assert_eq!(rejected.unwrap_err().stage, "login");
    assert!(store.load::<String>("identity.plist").unwrap().is_none());
    let saved = initialize(&store, None, create(&calls, Ok("private keys".to_owned())))
        .await
        .unwrap();
    assert_eq!(
        restore::<String>(&store, false).unwrap(),
        Some(saved.clone())
    );
    let restored = initialize(
        &store,
        Some(saved),
        create(&calls, Ok("unexpected".to_owned())),
    )
    .await
    .unwrap();
    assert_eq!(restored, "private keys");
    assert_eq!(calls.load(Ordering::Relaxed), 2);
    std::fs::write(path.join("identity.plist"), b"corrupt").unwrap();
    assert_eq!(
        restore::<String>(&store, true).unwrap_err().stage,
        "state_decode"
    );
    std::fs::remove_file(path.join("identity.plist")).unwrap();
    std::fs::create_dir_all(path.join("identity.plist/occupied")).unwrap();
    let failed = initialize(&store, None, create(&calls, Ok("new keys".to_owned()))).await;
    assert_eq!(failed.unwrap_err().stage, "state_write");
    drop(store);
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn notifications_are_durable_before_notifying_and_survive_a_disconnected_consumer() {
    let (store, path) = fixture();
    let (notify, mut inbox) = mpsc::unbounded_channel();
    notification(&store, &"private message", &notify).unwrap();
    let name = inbox.try_recv().unwrap();
    assert_eq!(
        store.load::<String>(&name).unwrap().as_deref(),
        Some("private message")
    );
    assert!(name.starts_with("inbox-") && name.ends_with(".plist"));
    drop(inbox);
    notification(&store, &"offline", &notify).unwrap();
    assert_eq!(store.pending().unwrap().len(), 2);
    let (notify, mut inbox) = mpsc::unbounded_channel();
    std::fs::remove_dir_all(&path).unwrap();
    assert_eq!(
        notification(&store, &"unsaved", &notify).unwrap_err().stage,
        "state_write"
    );
    assert!(inbox.try_recv().is_err());
}

#[test]
fn preflight_rejects_empty_validation_data() {
    assert_eq!(
        validation(&[]).unwrap_err().cause["code"],
        "empty_validation_data"
    );
    assert!(validation(&[1]).is_ok());
}
