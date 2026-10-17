use super::*;

fn fixture() -> (Store, PathBuf) {
    let path = std::env::temp_dir()
        .join("opencode")
        .join(format!("ren-rustpush-{}", uuid::Uuid::new_v4()));
    let store = Store::open(path.clone()).unwrap();
    (store, path)
}

#[test]
fn state_survives_restart_is_private_and_rejects_concurrent_writers() {
    let (store, path) = fixture();
    assert!(Store::open(path.clone()).is_err());
    assert!(store.load::<String>("session.plist").unwrap().is_none());
    store.save("session.plist", &"secret").unwrap();
    store.save("session.plist", &"updated secret").unwrap();
    assert_eq!(
        fs::metadata(path.join("session.plist"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o700
    );
    drop(store);
    let reopened = Store::open(path.clone()).unwrap();
    assert_eq!(
        reopened.load::<String>("session.plist").unwrap().as_deref(),
        Some("updated secret")
    );
    reopened
        .save("inbox-0002.plist", &"second notification")
        .unwrap();
    reopened
        .save("inbox-0001.plist", &"first notification")
        .unwrap();
    drop(reopened);
    let reopened = Store::open(path.clone()).unwrap();
    assert_eq!(
        reopened.pending().unwrap(),
        vec!["inbox-0001.plist", "inbox-0002.plist"]
    );
    assert_eq!(
        reopened
            .load::<String>("inbox-0001.plist")
            .unwrap()
            .as_deref(),
        Some("first notification")
    );
    reopened.remove("inbox-0001.plist").unwrap();
    assert_eq!(reopened.pending().unwrap(), vec!["inbox-0002.plist"]);
    fs::write(
        path.join("session.plist"),
        b"bplist00corrupt private payload",
    )
    .unwrap();
    let error = reopened.load::<String>("session.plist").unwrap_err();
    assert!(!format!("{error:?}").contains("corrupt private payload"));
    drop(reopened);
    fs::remove_dir_all(path).unwrap();
}

#[test]
fn attachments_are_private_and_published_only_when_complete() {
    let (store, path) = fixture();
    let target = store.attachment("GUID-0.heic").unwrap();
    assert_eq!(
        fs::metadata(target.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    let empty = store.partial(&target).unwrap();
    assert!(store.commit(empty, &target).is_err());
    assert!(!target.exists() && !target.with_extension("partial").exists());
    let mut file = store.partial(&target).unwrap();
    file.write_all(b"image").unwrap();
    store.commit(file, &target).unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"image");
    assert_eq!(
        fs::metadata(&target).unwrap().permissions().mode() & 0o777,
        0o600
    );
    fs::remove_file(&target).unwrap();
    let mut file = store.partial(&target).unwrap();
    file.write_all(b"image").unwrap();
    fs::remove_file(target.with_extension("partial")).unwrap();
    assert!(store.commit(file, &target).is_err());
    assert!(store.remove("missing.plist").is_err());
    fs::write(path.join("attachments-file"), b"").unwrap();
    fs::remove_dir_all(path.join("attachments")).unwrap();
    fs::rename(path.join("attachments-file"), path.join("attachments")).unwrap();
    assert!(store.attachment("GUID-1.heic").is_err());
    assert!(store.partial(&path.join("missing/GUID-1.heic")).is_err());
    drop(store);
    fs::remove_dir_all(path).unwrap();
}

#[test]
fn unreadable_and_unreplaceable_state_fails_without_leaving_temporary_files() {
    let (store, path) = fixture();
    fs::create_dir_all(path.join("directory.plist/occupied")).unwrap();
    assert_eq!(
        store.load::<String>("directory.plist").unwrap_err().stage,
        "state_read"
    );
    assert_eq!(
        store.save("directory.plist", &"value").unwrap_err().stage,
        "state_write"
    );
    let names: Vec<_> = fs::read_dir(&path)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    assert!(
        names.iter().all(|name| !name.ends_with(".tmp")),
        "{names:?}"
    );
    drop(store);
    fs::remove_dir_all(path).unwrap();
}
