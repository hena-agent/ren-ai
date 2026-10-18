use super::*;

const NOTI: &str = "mailto:noti@renai.im";

async fn assert_no_events(mut h: Harness) {
    h.request(json!({"id": 1, "method": "handles", "params": {}}))
        .await;
    assert_eq!(h.next().await["id"], 1);
    h.finish().await;
}

#[tokio::test]
async fn explicit_senders_keep_notifications_separate_and_fail_closed() {
    let mut h = Harness::start(Fake::default(), REDELIVER, |_| {}).await;
    h.fake
        .extra_handles
        .lock()
        .unwrap()
        .extend([NOTI.into(), "mailto:personal@example.test".into()]);
    for from in [US, NOTI, US] {
        let result = h
            .call(
                1,
                "send",
                json!({
                    "from": from, "guid": GUID, "to": THEM, "text": "private"
                }),
            )
            .await;
        assert_eq!(result["result"]["status"], "sent");
    }
    {
        let sent = h.fake.sent.lock().unwrap();
        assert_eq!(
            sent.iter()
                .map(|m| m.sender.as_deref().unwrap())
                .collect::<Vec<_>>(),
            [US, NOTI, US]
        );
        assert_eq!(
            sent[1].conversation.as_ref().unwrap().participants,
            [NOTI, THEM]
        );
    }
    for from in [
        "mailto:personal@example.test",
        "mailto:unknown@example.test",
    ] {
        let result = h
            .call(
                2,
                "send",
                json!({
                    "from": from, "guid": GUID, "to": THEM, "text": "private"
                }),
            )
            .await;
        assert_eq!(result["error"]["cause"]["code"], "invalid_sender");
    }
    h.fake.extra_handles.lock().unwrap().clear();
    let missing = h
        .call(
            3,
            "send",
            json!({
                "from": NOTI, "guid": GUID, "to": THEM, "text": "private"
            }),
        )
        .await;
    assert_eq!(missing["error"]["stage"], "input");
    assert_eq!(missing["error"]["cause"]["code"], "sender_not_registered");
    assert_eq!(h.fake.sent.lock().unwrap().len(), 3);
    h.finish().await;
}

#[tokio::test]
async fn notification_replies_are_discarded_before_downloading_attachments() {
    for target in [Some(NOTI), Some("mailto:personal@example.test"), None] {
        let fake = Fake::default();
        // A failed Apple acknowledgement must retain the spool and retry certification,
        // without ever publishing the reply or downloading its attachment.
        *fake.certify_failures.lock().unwrap() = 1;
        let mut body = NormalMessage::new("private reply".into(), MessageType::IMessage);
        body.parts.0.push(photo("image/heic"));
        // The sender claims the Persona participants, but IDS addressed a different local handle.
        let message = incoming(Message::Message(body));
        fake.decodes.lock().unwrap().insert(
            "reply".into(),
            VecDeque::from([Script::Message(Box::new(message))]),
        );
        let h = Harness::start(fake, RESCAN, |store| {
            spool_to(store, "inbox-1.plist", "reply", target)
        })
        .await;
        h.drained().await;
        assert_eq!(*h.fake.downloads.lock().unwrap(), 0);
        assert_eq!(*h.fake.certified.lock().unwrap(), vec![GUID]);
        assert_no_events(h).await;
    }
}

#[tokio::test]
async fn receipts_without_a_destination_still_reconcile_notifications() {
    for (message, kind) in [(Message::Delivered, "delivered"), (Message::Read, "read")] {
        let fake = Fake::default();
        fake.decodes.lock().unwrap().insert(
            "receipt".into(),
            VecDeque::from([Script::Message(Box::new(incoming(message)))]),
        );
        let mut h = Harness::start(fake, REDELIVER, |store| {
            spool_to(store, "inbox-1.plist", "receipt", None)
        })
        .await;
        let event = h.next().await;
        assert_eq!(event["message"]["kind"], kind);
        h.call(1, "ack", json!({"spool": "inbox-1.plist"})).await;
        h.drained().await;
        assert_eq!(*h.fake.certified.lock().unwrap(), vec![GUID]);
        h.finish().await;
    }
}

#[tokio::test]
async fn non_message_spool_records_do_not_create_a_persona_event() {
    let h = Harness::start(Fake::default(), REDELIVER, |store| {
        store.save("inbox-1.plist", &APSMessage::Ping).unwrap()
    })
    .await;
    h.drained().await;
    assert_no_events(h).await;
}
