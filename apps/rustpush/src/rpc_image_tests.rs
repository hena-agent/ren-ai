use super::*;
use std::os::unix::fs::PermissionsExt;

pub(super) async fn upload(fake: &Fake, jpeg: &[u8]) -> Result<Attachment, Failure> {
    fake.uploads.lock().unwrap().push(jpeg.to_vec());
    if fake.hang_upload.load(std::sync::atomic::Ordering::Relaxed) {
        std::future::pending::<()>().await;
    }
    if let Some(failure) = fake.upload_failure.lock().unwrap().take() {
        return Err(failure);
    }
    Ok(Attachment {
        a_type: AttachmentType::MMCS(vec![rustpush::MMCSFile {
            signature: vec![1],
            object: "uploaded".into(),
            url: "https://example.test/mmcs".into(),
            key: vec![2],
            size: jpeg.len(),
        }]),
        part: 0,
        uti_type: "public.jpeg".into(),
        mime: "image/jpeg".into(),
        name: "photo.jpg".into(),
        iris: false,
    })
}

// One gray pixel, baseline JPEG with a single zero-coefficient block.
fn jpeg() -> Vec<u8> {
    let mut bytes = vec![0xff, 0xd8, 0xff, 0xdb, 0, 67, 0];
    bytes.extend([1; 64]);
    bytes.extend([0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0]);
    for table in [0, 0x10] {
        bytes.extend([0xff, 0xc4, 0, 20, table, 1]);
        bytes.extend([0; 16]);
    }
    bytes.extend([0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0x3f, 0xff, 0xd9]);
    bytes
}

fn stage(h: &Harness, bytes: &[u8]) -> Value {
    let path = h.path.join("private-photo.jpg");
    std::fs::write(&path, bytes).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    json!({"from": US, "guid": GUID, "to": THEM, "path": path})
}

#[tokio::test]
async fn image_rpc_uploads_then_sends_only_the_attachment_with_the_supplied_guid() {
    let mut h = Harness::start(Fake::default(), REDELIVER, |_| {}).await;
    let bytes = jpeg();
    let input = stage(&h, &bytes);
    assert_eq!(
        h.call(1, "send_image", input).await["result"],
        json!({"guid": GUID, "status": "sent"})
    );
    assert_eq!(*h.fake.uploads.lock().unwrap(), vec![bytes]);
    {
        let sent = h.fake.sent.lock().unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].id, GUID);
        assert_eq!(sent[0].sender.as_deref(), Some(US));
        assert_eq!(
            sent[0].conversation.as_ref().unwrap().participants,
            [US, THEM]
        );
        let Message::Message(body) = &sent[0].message else {
            panic!("ordinary iMessage required")
        };
        assert!(matches!(body.service, MessageType::IMessage));
        assert_eq!(body.parts.0.len(), 1);
        let MessagePart::Attachment(attachment) = &body.parts.0[0].part else {
            panic!("attachment required")
        };
        assert!(matches!(attachment.a_type, AttachmentType::MMCS(_)));
        assert_eq!(attachment.name, "photo.jpg");
        assert_eq!(attachment.mime, "image/jpeg");
        assert_eq!(attachment.uti_type, "public.jpeg");
        assert_eq!(attachment.part, 0);
        assert!(!attachment.iris);
    }
    h.finish().await;
}

#[tokio::test]
async fn upload_failure_is_definitively_unsent_and_send_failure_stays_uncertain() {
    let mut h = Harness::start(Fake::default(), REDELIVER, |_| {}).await;
    let input = stage(&h, &jpeg());
    *h.fake.upload_failure.lock().unwrap() = Some(Failure::push(
        "attachment_upload",
        rustpush::PushError::SendErr(503),
    ));
    let failed = h.call(1, "send_image", input.clone()).await;
    assert_eq!(failed["result"]["status"], "failed");
    assert_eq!(failed["result"]["guid"], GUID);
    assert_eq!(failed["result"]["code"], "attachment_upload_failed");
    assert_eq!(failed["result"]["cause"]["cause"]["code"], 503);
    assert!(h.fake.sent.lock().unwrap().is_empty());
    h.fake
        .deliveries
        .lock()
        .unwrap()
        .push_back(Err(Failure::new("send", "unconfirmed")));
    let uncertain = h.call(2, "send_image", input.clone()).await;
    assert_eq!(uncertain["error"]["stage"], "send");
    assert_eq!(uncertain["error"]["cause"]["code"], "unconfirmed");
    assert_eq!(uncertain["error"]["requestId"], GUID.to_lowercase());
    h.fake
        .deliveries
        .lock()
        .unwrap()
        .push_back(Ok(Delivery::Failed("no_imessage")));
    assert_eq!(
        h.call(3, "send_image", input).await["result"],
        json!({"guid": GUID, "status": "failed", "code": "no_imessage"})
    );
    assert_eq!(h.fake.sent.lock().unwrap().len(), 2);
    assert_eq!(h.fake.uploads.lock().unwrap().len(), 3);
    let reply = failed.to_string();
    for private in ["private-photo", US, THEM, "https://"] {
        assert!(!reply.contains(private));
    }
    h.finish().await;
}

#[tokio::test(start_paused = true)]
async fn stalled_upload_is_definitively_unsent_before_the_request_deadline() {
    let fake = Fake::default();
    fake.hang_upload
        .store(true, std::sync::atomic::Ordering::Relaxed);
    let mut h = Harness::start(fake, REDELIVER, |_| {}).await;
    let input = stage(&h, &jpeg());
    h.request(json!({"id": 1, "method": "send_image", "params": input}))
        .await;
    // Allow the request task to start before advancing its deadline.
    tokio::task::yield_now().await;
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_secs(91)).await;
    let failed = h.next().await;
    assert_eq!(failed["result"]["code"], "attachment_upload_failed");
    assert_eq!(failed["result"]["cause"]["cause"]["code"], "timeout");
    assert!(h.fake.sent.lock().unwrap().is_empty());
    h.finish().await;
}

#[tokio::test]
async fn invalid_images_and_inputs_never_upload_or_send() {
    let mut h = Harness::start(Fake::default(), REDELIVER, |_| {}).await;
    let input = stage(&h, &jpeg());
    for (key, value, code) in [
        ("guid", json!("invalid"), "invalid_guid"),
        ("to", json!(US), "invalid_recipient"),
        (
            "from",
            json!("mailto:personal@example.test"),
            "invalid_sender",
        ),
        ("from", json!(NOTIFICATION_HANDLE), "sender_not_registered"),
        ("path", json!("relative.jpg"), "invalid_image_path"),
        ("path", Value::Null, "invalid_params"),
        (
            "url",
            json!("https://example.test/image.jpg"),
            "invalid_params",
        ),
    ] {
        let mut invalid = input.clone();
        invalid[key] = value;
        let reply = h.call(1, "send_image", invalid).await;
        assert_eq!(reply["error"]["stage"], "input");
        assert_eq!(reply["error"]["cause"]["code"], code);
    }
    for bytes in [vec![], b"not a jpeg".to_vec(), vec![0xff, 0xd8, 0xff, 0xd9]] {
        let invalid = stage(&h, &bytes);
        assert_eq!(
            h.call(2, "send_image", invalid).await["error"]["cause"]["code"],
            "invalid_jpeg"
        );
    }
    let oversized = stage(&h, &vec![0; 10_000_001]);
    assert_eq!(
        h.call(3, "send_image", oversized).await["error"]["cause"]["code"],
        "image_too_large"
    );
    let mut directory = input.clone();
    directory["path"] = json!(h.path);
    assert_eq!(
        h.call(4, "send_image", directory).await["error"]["cause"]["code"],
        "image_not_private_file"
    );
    std::fs::set_permissions(
        input["path"].as_str().unwrap(),
        std::fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    assert_eq!(
        h.call(5, "send_image", input.clone()).await["error"]["cause"]["code"],
        "image_not_private_file"
    );
    std::fs::remove_file(input["path"].as_str().unwrap()).unwrap();
    assert_eq!(
        h.call(6, "send_image", input.clone()).await["error"]["stage"],
        "input"
    );
    std::os::unix::fs::symlink("missing", input["path"].as_str().unwrap()).unwrap();
    assert_eq!(
        h.call(7, "send_image", input).await["error"]["stage"],
        "input"
    );
    assert!(h.fake.uploads.lock().unwrap().is_empty());
    assert!(h.fake.sent.lock().unwrap().is_empty());
    h.finish().await;
}

struct FailAt(&'static str);

impl crate::io::Io for FailAt {
    fn check(&self, stage: &'static str) -> std::io::Result<()> {
        if stage == self.0 {
            Err(std::io::Error::other("private path must not appear"))
        } else {
            Ok(())
        }
    }
}

#[tokio::test]
async fn filesystem_failures_after_open_are_definitively_unsent_and_redacted() {
    let h = Harness::start(Fake::default(), REDELIVER, |_| {}).await;
    let input = stage(&h, &jpeg());
    for stage in ["image_open", "image_metadata", "image_read"] {
        let error =
            super::super::image::jpeg(input["path"].as_str().unwrap(), &FailAt(stage)).unwrap_err();
        assert_eq!(error.stage, "input");
        assert_eq!(error.cause, json!({"kind": "Other", "os_code": null}));
    }
    h.finish().await;
}
