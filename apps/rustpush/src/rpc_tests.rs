use super::*;
use rustpush::{
    AttachmentType, ConversationData, IndexedMessagePart, Message, MessagePart, MessageParts,
    MessageType, NormalMessage, TextFormat,
};
use std::io::Write;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};

const US: &str = "mailto:service@example.test";
const THEM: &str = "tel:+15550100";
const GUID: &str = "5D4C3B2A-0000-4000-8000-000000000001";

enum Script {
    Message(Box<MessageInst>),
    Nothing,
    Fail,
}

#[derive(Default)]
struct Fake {
    decodes: Mutex<HashMap<String, VecDeque<Script>>>,
    certified: Mutex<Vec<String>>,
    certify_failures: Mutex<u32>,
    download_failures: Mutex<u32>,
    downloads: Mutex<u32>,
    sent: Mutex<Vec<MessageInst>>,
    deliveries: Mutex<VecDeque<Result<Delivery, Failure>>>,
}

impl Native for Fake {
    async fn handles(&self) -> Vec<String> {
        vec![US.to_owned()]
    }

    async fn decode(&self, raw: APSMessage) -> Result<Option<MessageInst>, Failure> {
        let APSMessage::Notification { payload, .. } = raw else {
            panic!("spooled a non-notification");
        };
        let marker = payload.as_string().unwrap().to_owned();
        let script = self
            .decodes
            .lock()
            .unwrap()
            .get_mut(&marker)
            .unwrap()
            .pop_front();
        match script.unwrap() {
            Script::Message(message) => Ok(Some(*message)),
            Script::Nothing => Ok(None),
            Script::Fail => Err(Failure::new("decode", "scripted")),
        }
    }

    async fn certify(&self, message: &MessageInst) -> Result<(), Failure> {
        let mut failures = self.certify_failures.lock().unwrap();
        if *failures > 0 {
            *failures -= 1;
            return Err(Failure::new("certify_delivery", "scripted"));
        }
        self.certified.lock().unwrap().push(message.id.clone());
        Ok(())
    }

    async fn download(&self, _attachment: &Attachment, file: &mut File) -> Result<(), Failure> {
        *self.downloads.lock().unwrap() += 1;
        let mut failures = self.download_failures.lock().unwrap();
        if *failures > 0 {
            *failures -= 1;
            return Err(Failure::new("attachment_download", "scripted"));
        }
        file.write_all(b"image").unwrap();
        Ok(())
    }

    async fn send(&self, message: MessageInst) -> Result<Delivery, Failure> {
        self.sent.lock().unwrap().push(message);
        self.deliveries
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Ok(Delivery::Sent))
    }
}

struct Harness {
    fake: Arc<Fake>,
    store: Arc<Store>,
    path: std::path::PathBuf,
    input: DuplexStream,
    output: tokio::io::Lines<BufReader<DuplexStream>>,
    inbox: mpsc::UnboundedSender<String>,
    served: tokio::task::JoinHandle<()>,
}

const REDELIVER: Timing = Timing {
    ack: Duration::from_millis(50),
    rescan: Duration::from_secs(60),
    download_retry: Duration::from_millis(1),
};

const RESCAN: Timing = Timing {
    ack: Duration::from_secs(60),
    rescan: Duration::from_millis(50),
    download_retry: Duration::from_millis(1),
};

fn spool(store: &Store, name: &str, marker: &str) {
    let raw = APSMessage::Notification {
        id: 1,
        topic: [0; 20],
        token: None,
        payload: plist::Value::String(marker.into()),
        channel: None,
    };
    store.save(name, &raw).unwrap();
}

fn incoming(message: Message) -> MessageInst {
    let conversation = ConversationData {
        participants: vec![THEM.into(), US.into()],
        cv_name: None,
        sender_guid: None,
        after_guid: None,
    };
    let mut inst = MessageInst::new(conversation, THEM, message);
    inst.id = GUID.into();
    inst
}

fn photo(mime: &str) -> IndexedMessagePart {
    IndexedMessagePart {
        part: MessagePart::Attachment(Attachment {
            a_type: AttachmentType::Inline(vec![1]),
            part: 0,
            uti_type: "public.heic".into(),
            mime: mime.into(),
            name: "IMG.HEIC".into(),
            iris: false,
        }),
        idx: None,
        ext: None,
    }
}

impl Harness {
    async fn start(fake: Fake, timing: Timing, setup: impl FnOnce(&Store)) -> Self {
        let path = std::env::temp_dir()
            .join("opencode")
            .join(format!("ren-rustpush-rpc-{}", uuid::Uuid::new_v4()));
        let store = Arc::new(Store::open(path.clone()).unwrap());
        setup(&store);
        let fake = Arc::new(fake);
        let (input, server_input) = tokio::io::duplex(1 << 16);
        let (server_output, output) = tokio::io::duplex(1 << 16);
        let (inbox, receiver) = mpsc::unbounded_channel();
        let session = Session {
            native: fake.clone(),
            store: store.clone(),
            handle: US.into(),
            pending: store.pending().unwrap(),
            inbox: receiver,
        };
        let served = tokio::spawn(serve(
            session,
            BufReader::new(server_input),
            server_output,
            timing,
            "test",
        ));
        let output = BufReader::new(output).lines();
        Self {
            fake,
            store,
            path,
            input,
            output,
            inbox,
            served,
        }
    }

    async fn request(&mut self, line: Value) {
        self.input
            .write_all(format!("{line}\n").as_bytes())
            .await
            .unwrap();
    }

    async fn next(&mut self) -> Value {
        let line = tokio::time::timeout(Duration::from_secs(5), self.output.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        serde_json::from_str(&line).unwrap()
    }

    /// The response to a request, skipping any redelivered events.
    async fn call(&mut self, id: u64, method: &str, params: Value) -> Value {
        self.request(json!({"id": id, "method": method, "params": params}))
            .await;
        loop {
            let line = self.next().await;
            if line["id"] == id {
                return line;
            }
        }
    }

    async fn drained(&self) {
        for _ in 0..200 {
            if self.store.pending().unwrap().is_empty() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("spool was not drained");
    }

    async fn finish(self) {
        drop(self.input);
        tokio::time::timeout(Duration::from_secs(5), self.served)
            .await
            .unwrap()
            .unwrap();
        drop(self.store);
        let _ = std::fs::remove_dir_all(self.path);
    }
}

#[tokio::test]
async fn requests_send_from_the_service_handle_and_reject_invalid_input() {
    let fake = Fake::default();
    fake.deliveries.lock().unwrap().extend([
        Ok(Delivery::Failed("no_imessage")),
        Err(Failure::new("send", "unconfirmed")),
    ]);
    let mut h = Harness::start(fake, REDELIVER, |_| {}).await;
    assert_eq!(
        h.call(1, "handles", json!({})).await,
        json!({"id": 1, "result": {"handles": [US]}})
    );
    let send = json!({"guid": GUID, "to": THEM, "text": "hi"});
    assert_eq!(
        h.call(2, "send", send.clone()).await["result"],
        json!({"status": "failed", "code": "no_imessage"})
    );
    let uncertain = h.call(3, "send", send.clone()).await;
    assert_eq!(
        uncertain["error"],
        json!({"stage": "send", "cause": {"code": "unconfirmed"}})
    );
    assert_eq!(
        h.call(4, "send", send).await["result"],
        json!({"status": "sent"})
    );
    let typing = json!({"to": THEM, "active": true});
    assert_eq!(
        h.call(5, "typing", typing).await["result"]["status"],
        "sent"
    );
    let read = json!({"to": THEM, "guid": GUID});
    assert_eq!(h.call(6, "read", read).await["result"]["status"], "sent");
    let react = json!({"to": THEM, "guid": GUID, "tapback": "love", "text": "quoted"});
    assert_eq!(h.call(7, "react", react).await["result"]["status"], "sent");
    {
        let sent = h.fake.sent.lock().unwrap();
        assert_eq!(sent.len(), 6);
        assert!(sent
            .iter()
            .all(|message| message.sender.as_deref() == Some(US)));
        assert_eq!(sent[0].id, GUID);
        assert!(matches!(sent[3].message, Message::Typing(true, None)));
        assert!(matches!(sent[4].message, Message::Read) && sent[4].id == GUID);
        assert!(matches!(sent[5].message, Message::React(_)));
    }
    let code = |value: Value| value["error"]["cause"]["code"].clone();
    for (method, params, expected) in [
        (
            "send",
            json!({"guid": "nope", "to": THEM, "text": "x"}),
            "invalid_guid",
        ),
        (
            "send",
            json!({"guid": GUID, "to": US, "text": "x"}),
            "invalid_recipient",
        ),
        (
            "send",
            json!({"guid": GUID, "to": "15550100", "text": "x"}),
            "invalid_recipient",
        ),
        ("send", json!({"guid": GUID, "to": THEM}), "invalid_params"),
        (
            "typing",
            json!({"to": "x", "active": false}),
            "invalid_recipient",
        ),
        ("read", json!({"to": THEM, "guid": "nope"}), "invalid_guid"),
        (
            "react",
            json!({"to": "x", "guid": GUID, "tapback": "love", "text": ""}),
            "invalid_recipient",
        ),
        (
            "react",
            json!({"to": THEM, "guid": GUID, "tapback": "wave", "text": ""}),
            "unknown_tapback",
        ),
        ("delete", json!({}), "unknown_method"),
        ("ack", json!({"guid": GUID}), "invalid_params"),
    ] {
        assert_eq!(
            code(h.call(8, method, params).await),
            json!(expected),
            "{method}"
        );
    }
    h.input.write_all(b"not json\n").await.unwrap();
    assert_eq!(
        h.call(9, "ack", json!({"spool": "none"})).await["result"],
        json!({"acknowledged": false})
    );
    assert_eq!(h.fake.sent.lock().unwrap().len(), 6);
    h.finish().await;
}

#[tokio::test]
async fn notifications_leave_the_spool_only_after_the_gateway_acknowledges_them() {
    let fake = Fake::default();
    let mut body = NormalMessage::new("look".into(), MessageType::IMessage);
    body.parts.0.extend([
        photo("image/heic"),
        photo("image/heic"),
        photo("video/quicktime"),
    ]);
    let photo_message = incoming(Message::Message(body));
    *fake.download_failures.lock().unwrap() = 2;
    fake.decodes.lock().unwrap().extend([
        (
            "first".to_owned(),
            VecDeque::from([Script::Message(Box::new(photo_message))]),
        ),
        ("nothing".to_owned(), VecDeque::from([Script::Nothing])),
        (
            "typing".to_owned(),
            VecDeque::from([Script::Message(Box::new(incoming(Message::Typing(
                true, None,
            ))))]),
        ),
    ]);
    let mut h = Harness::start(fake, REDELIVER, |store| {
        spool(store, "inbox-1.plist", "first");
        spool(store, "inbox-2.plist", "nothing");
        spool(store, "inbox-3.plist", "typing");
    })
    .await;
    let event = h.next().await;
    assert_eq!(
        (&event["event"], &event["spool"]),
        (&json!("message"), &json!("inbox-1.plist"))
    );
    let message = &event["message"];
    assert_eq!(
        (&message["guid"], &message["kind"]),
        (&json!(GUID), &json!("text"))
    );
    let paths: Vec<Value> = message["attachments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|attachment| attachment["path"].clone())
        .collect();
    assert!(paths[0]
        .as_str()
        .unwrap()
        .ends_with(&format!("attachments/{GUID}-0.heic")));
    assert!(paths[1]
        .as_str()
        .unwrap()
        .ends_with(&format!("attachments/{GUID}-1.heic")));
    assert_eq!(paths[2], Value::Null);
    assert_eq!(*h.fake.downloads.lock().unwrap(), 4);
    assert!(h
        .store
        .load::<APSMessage>("inbox-1.plist")
        .unwrap()
        .is_some());
    assert!(h.fake.certified.lock().unwrap().is_empty());
    let redelivered = h.next().await;
    assert_eq!(redelivered, event);
    let ack = h.call(1, "ack", json!({"spool": "inbox-1.plist"})).await;
    assert_eq!(ack["result"], json!({"acknowledged": true}));
    h.drained().await;
    assert_eq!(*h.fake.certified.lock().unwrap(), vec![GUID, GUID]);
    h.finish().await;
}

#[tokio::test]
async fn failed_notifications_stay_spooled_and_are_retried() {
    let fake = Fake::default();
    let mut body = NormalMessage::new(String::new(), MessageType::IMessage);
    body.parts = MessageParts(vec![
        IndexedMessagePart {
            part: MessagePart::Text("hi".into(), TextFormat::default()),
            idx: None,
            ext: None,
        },
        photo("image/heic"),
    ]);
    let message = incoming(Message::Message(body));
    *fake.certify_failures.lock().unwrap() = 1;
    fake.decodes.lock().unwrap().insert(
        "late".into(),
        VecDeque::from([
            Script::Fail,
            Script::Message(Box::new(message.clone())),
            Script::Message(Box::new(message)),
        ]),
    );
    let mut h = Harness::start(fake, RESCAN, |store| {
        let path = store.attachment(&format!("{GUID}-0.heic")).unwrap();
        std::fs::write(path, b"saved").unwrap();
    })
    .await;
    spool(&h.store, "inbox-9.plist", "late");
    h.inbox.send("inbox-9.plist".into()).unwrap();
    h.inbox.send("inbox-missing.plist".into()).unwrap();
    for attempt in 1..=2 {
        let event = h.next().await;
        assert_eq!(event["spool"], "inbox-9.plist", "attempt {attempt}");
        assert!(event["message"]["attachments"][0]["path"]
            .as_str()
            .unwrap()
            .ends_with(".heic"));
        let ack = h
            .call(attempt, "ack", json!({"spool": "inbox-9.plist"}))
            .await;
        assert_eq!(ack["result"]["acknowledged"], true);
    }
    h.drained().await;
    assert_eq!(*h.fake.downloads.lock().unwrap(), 0);
    assert_eq!(h.fake.certified.lock().unwrap().len(), 1);
    std::fs::remove_dir_all(h.path.join("attachments")).unwrap();
    std::fs::write(h.path.join("attachments"), b"").unwrap();
    spool(&h.store, "inbox-10.plist", "late");
    h.fake.decodes.lock().unwrap().insert(
        "late".into(),
        VecDeque::from([Script::Message(Box::new(incoming(Message::Message(
            NormalMessage {
                parts: MessageParts(vec![photo("image/png")]),
                ..NormalMessage::new(String::new(), MessageType::IMessage)
            },
        ))))]),
    );
    h.inbox.send("inbox-10.plist".into()).unwrap();
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(h
        .store
        .load::<APSMessage>("inbox-10.plist")
        .unwrap()
        .is_some());
    assert_eq!(
        h.call(4, "handles", json!({})).await["result"]["handles"][0],
        US
    );
    h.finish().await;
}

#[path = "rpc_recovery_tests.rs"]
mod recovery;
