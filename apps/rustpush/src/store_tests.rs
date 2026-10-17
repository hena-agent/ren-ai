use super::*;

#[derive(Clone)]
struct Fault(std::sync::Arc<std::sync::Mutex<&'static str>>);

impl Io for Fault {
    fn check(&self, stage: &'static str) -> std::io::Result<()> {
        if *self.0.lock().unwrap() == stage {
            Err(std::io::Error::from_raw_os_error(5))
        } else {
            Ok(())
        }
    }
}

#[test]
fn failed_disk_operations_do_not_publish_partial_data_or_hide_errors() {
    let (store, path) = fixture();
    drop(store);
    let fault = Fault(std::sync::Arc::new(std::sync::Mutex::new(
        "state_permissions",
    )));
    assert_eq!(
        Store::using(path.clone(), Box::new(fault.clone()))
            .err()
            .unwrap()
            .stage,
        "state_permissions"
    );
    *fault.0.lock().unwrap() = "";
    let store = Store::using(path.clone(), Box::new(fault.clone())).unwrap();
    assert_eq!(
        Store::using(path.clone(), Box::new(fault.clone()))
            .err()
            .unwrap()
            .stage,
        "state_lock"
    );
    assert!(store.load::<String>("missing.plist").unwrap().is_none());
    std::fs::create_dir(path.join("directory.plist")).unwrap();
    assert_eq!(
        store.load::<String>("directory.plist").unwrap_err().stage,
        "state_read"
    );
    std::fs::write(path.join("corrupt.plist"), b"corrupt").unwrap();
    assert_eq!(
        store.load::<String>("corrupt.plist").unwrap_err().stage,
        "state_decode"
    );
    store.save("identity.plist", &"original").unwrap();
    for stage in ["state_create", "state_write", "state_sync"] {
        *fault.0.lock().unwrap() = stage;
        assert_eq!(
            store
                .save("identity.plist", &"replacement")
                .unwrap_err()
                .stage,
            "state_write"
        );
        assert_eq!(
            store.load::<String>("identity.plist").unwrap().as_deref(),
            Some("original")
        );
        assert!(fs::read_dir(&path).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")));
    }
    *fault.0.lock().unwrap() = "state_parent";
    assert_eq!(
        store
            .save("identity.plist", &"replacement")
            .unwrap_err()
            .stage,
        "state_write"
    );
    assert_eq!(
        store.load::<String>("identity.plist").unwrap().as_deref(),
        Some("replacement")
    );
    *fault.0.lock().unwrap() = "inbox_entry";
    assert_eq!(store.pending().unwrap_err().stage, "inbox_list");
    for stage in ["attachment_sync", "attachment_size"] {
        *fault.0.lock().unwrap() = stage;
        let target = store.attachment("photo.heic").unwrap();
        let mut file = store.partial(&target).unwrap();
        file.write_all(b"private image").unwrap();
        assert_eq!(store.commit(file, &target).unwrap_err().stage, stage);
        assert!(!target.exists());
        assert!(!target.with_extension("partial").exists());
    }
    *fault.0.lock().unwrap() = "";
    let target = store.attachment("photo.heic").unwrap();
    let mut file = store.partial(&target).unwrap();
    file.write_all(b"complete image").unwrap();
    store.commit(file, &target).unwrap();
    assert_eq!(fs::read(target).unwrap(), b"complete image");
    drop(store);
    fs::remove_dir_all(path).unwrap();
}

pub(crate) fn fixture() -> (Store, PathBuf) {
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

#[test]
fn invalid_state_never_replaces_a_durable_file() {
    struct State(Option<&'static str>);
    impl Serialize for State {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            match self.0 {
                Some(value) => serializer.serialize_str(value),
                None => Err(serde::ser::Error::custom("private invalid state")),
            }
        }
    }
    let (store, path) = fixture();
    store
        .save("identity.plist", &State(Some("durable")))
        .unwrap();
    let error = store.save("identity.plist", &State(None)).unwrap_err();
    assert_eq!(error.stage, "state_encode");
    assert!(!format!("{error:?}").contains("private invalid"));
    assert_eq!(
        store.load::<String>("identity.plist").unwrap().as_deref(),
        Some("durable")
    );
    drop(store);
    fs::remove_file(path.join("lock")).unwrap();
    fs::create_dir(path.join("lock")).unwrap();
    assert_eq!(Store::open(path.clone()).err().unwrap().stage, "state_lock");
    assert_eq!(
        Store::open(path.join("identity.plist"))
            .err()
            .unwrap()
            .stage,
        "state_directory"
    );
    fs::remove_dir_all(path).unwrap();
}
