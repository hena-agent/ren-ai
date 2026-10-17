use super::*;
use crate::delivery::outcome;
use rustpush::SendResult;
use tokio::sync::broadcast;

#[tokio::test(start_paused = true)]
async fn unresponsive_submissions_time_out_without_retrying() {
    let fake = Fake::default();
    fake.hang_sends
        .store(true, std::sync::atomic::Ordering::Relaxed);
    let mut h = Harness::start(fake, RESCAN, |_| {}).await;
    h.request(
        json!({"id": 1, "method": "send", "params": {"guid": GUID, "to": THEM, "text": "private"}}),
    )
    .await;
    while h.fake.sent.lock().unwrap().is_empty() {
        tokio::task::yield_now().await;
    }
    tokio::time::advance(Duration::from_secs(121)).await;
    let response = h.next().await;
    assert_eq!(
        response["error"]["cause"]["code"],
        "timeout_outcome_uncertain"
    );
    assert_eq!(h.fake.sent.lock().unwrap().len(), 1);
    h.finish().await;
}

#[tokio::test]
async fn a_closed_event_channel_never_counts_as_gateway_acknowledgement() {
    let (output, receiver) = mpsc::unbounded_channel();
    drop(receiver);
    let failure = deliver(
        "inbox-1.plist",
        json!({}),
        &output,
        &Acks::default(),
        &REDELIVER,
    )
    .await
    .unwrap_err();
    assert_eq!(failure.stage, "gateway");
    assert_eq!(failure.cause["code"], "output_closed");
}

#[tokio::test]
async fn unreadable_notifications_and_failed_gateway_writes_remain_spooled() {
    let h = Harness::start(Fake::default(), REDELIVER, |_| {}).await;
    let (output, receiver) = mpsc::unbounded_channel();
    drop(receiver);
    let inbound = Inbound {
        native: h.fake.clone(),
        store: h.store.clone(),
        output,
        acks: Acks::default(),
        timing: REDELIVER,
        request_id: "test".into(),
    };
    h.fake.decodes.lock().unwrap().insert(
        "kept".into(),
        VecDeque::from([Script::Message(Box::new(incoming(Message::Delivered)))]),
    );
    spool(&h.store, "kept.plist", "kept");
    assert_eq!(
        inbound.process("kept.plist").await.unwrap_err().stage,
        "gateway"
    );
    assert!(h.store.load::<APSMessage>("kept.plist").unwrap().is_some());
    assert!(h.fake.certified.lock().unwrap().is_empty());
    std::fs::write(h.path.join("kept.plist"), b"invalid private state").unwrap();
    assert_eq!(
        inbound.process("kept.plist").await.unwrap_err().stage,
        "state_decode"
    );
    assert!(h.path.join("kept.plist").exists());
    h.finish().await;
}

#[tokio::test]
async fn an_unwritable_attachment_stays_unpublished_after_bounded_retries() {
    let h = Harness::start(Fake::default(), REDELIVER, |_| {}).await;
    let target = h.store.attachment("photo.heic").unwrap();
    std::fs::create_dir(target.with_extension("partial")).unwrap();
    let MessagePart::Attachment(attachment) = photo("image/heic").part else {
        unreachable!()
    };
    let failure = download(
        &*h.fake,
        &h.store,
        "photo.heic",
        &attachment,
        &REDELIVER,
        "test",
    )
    .await
    .unwrap_err();
    assert_eq!(failure.stage, "attachment_create");
    assert!(!target.exists());
    assert_eq!(*h.fake.downloads.lock().unwrap(), 0);
    h.finish().await;
}

#[tokio::test]
async fn failed_image_downloads_keep_the_notification_until_the_image_is_saved() {
    let fake = Fake::default();
    *fake.download_failures.lock().unwrap() = 3;
    let mut body = NormalMessage::new(String::new(), MessageType::IMessage);
    body.parts = MessageParts(vec![photo("image/heic")]);
    let message = incoming(Message::Message(body));
    fake.decodes.lock().unwrap().insert(
        "image".into(),
        VecDeque::from([
            Script::Message(Box::new(message.clone())),
            Script::Message(Box::new(message)),
        ]),
    );
    let mut h = Harness::start(fake, RESCAN, |store| spool(store, "inbox-1.plist", "image")).await;
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(*h.fake.downloads.lock().unwrap(), 3);
    assert!(h.fake.certified.lock().unwrap().is_empty());
    assert_eq!(h.store.pending().unwrap().len(), 1);
    let event = h.next().await;
    assert!(event["message"]["attachments"][0]["path"].is_string());
    assert_eq!(*h.fake.downloads.lock().unwrap(), 4);
    h.call(1, "ack", json!({"spool": "inbox-1.plist"})).await;
    h.drained().await;
    h.finish().await;
}

#[tokio::test]
async fn only_unanimous_rejection_by_the_recipient_fails_a_send() {
    async fn decide(
        capacity: usize,
        results: Vec<(&str, SendResult)>,
    ) -> Result<Delivery, Failure> {
        let (sender, receiver) = broadcast::channel(capacity);
        for (participant, result) in results {
            assert!(sender.send((participant.to_owned(), result)).is_ok());
        }
        drop(sender);
        outcome(THEM, receiver, String::clone).await
    }
    for capacity in [1, 2] {
        let sent = decide(
            capacity,
            vec![(US, SendResult::APSError(1)), (THEM, SendResult::Sent)],
        )
        .await;
        assert_eq!(sent.unwrap(), Delivery::Sent);
    }
    let lost_acceptance = decide(
        1,
        vec![(THEM, SendResult::Sent), (THEM, SendResult::APSError(1))],
    )
    .await;
    assert_eq!(lost_acceptance.unwrap_err().cause["code"], "unconfirmed");
    assert_eq!(
        decide(1, vec![(THEM, SendResult::APSError(5000))])
            .await
            .unwrap(),
        Delivery::Failed("rejected")
    );
    for results in [
        vec![],
        vec![
            (THEM, SendResult::APSError(1)),
            (THEM, SendResult::TimedOut),
        ],
    ] {
        assert_eq!(
            decide(2, results).await.unwrap_err().cause["code"],
            "unconfirmed"
        );
    }
}

#[tokio::test]
async fn a_departed_gateway_leaves_notifications_spooled_and_unconfirmed() {
    let fake = Fake::default();
    let receipt = Script::Message(Box::new(incoming(Message::Delivered)));
    fake.decodes
        .lock()
        .unwrap()
        .insert("kept".into(), VecDeque::from([receipt]));
    let Harness {
        fake,
        store,
        path,
        input,
        output,
        inbox,
        served,
    } = Harness::start(fake, REDELIVER, |_| {}).await;
    drop(output);
    spool(&store, "inbox-1.plist", "kept");
    inbox.send("inbox-1.plist".into()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), served)
        .await
        .unwrap()
        .unwrap();
    assert!(store.load::<APSMessage>("inbox-1.plist").unwrap().is_some());
    assert!(fake.certified.lock().unwrap().is_empty());
    drop(input);
    drop(store);
    std::fs::remove_dir_all(path).unwrap();
}

#[tokio::test]
async fn an_unreadable_spool_is_reported_without_stopping_requests() {
    let mut h = Harness::start(Fake::default(), RESCAN, |_| {}).await;
    std::fs::remove_dir_all(&h.path).unwrap();
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(
        h.call(1, "handles", json!({})).await["result"]["handles"][0],
        US
    );
    h.finish().await;
}

#[tokio::test]
async fn losing_the_notification_source_stops_the_bridge_for_supervised_restart() {
    let mut h = Harness::start(Fake::default(), REDELIVER, |_| {}).await;
    drop(std::mem::replace(&mut h.inbox, mpsc::unbounded_channel().0));
    tokio::time::timeout(Duration::from_secs(5), &mut h.served)
        .await
        .unwrap()
        .unwrap();
    drop(h.store);
    std::fs::remove_dir_all(h.path).unwrap();
}
