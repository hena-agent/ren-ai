use super::*;
use rustpush::{
    AttachmentType, EditMessage, ExtensionApp, IndexedMessagePart, MessageParts, TextFormat,
    UnsendMessage,
};

const US: &str = "mailto:service@example.test";
const THEM: &str = "tel:+15550100";

fn incoming(message: Message) -> MessageInst {
    let mut inst = MessageInst::new(conversation(THEM, US), THEM, message);
    inst.id = "5D4C3B2A-0000-4000-8000-000000000001".into();
    inst.sent_timestamp = 1_700_000_000_123;
    inst
}

fn part(part: MessagePart) -> IndexedMessagePart {
    IndexedMessagePart {
        part,
        idx: None,
        ext: None,
    }
}

fn attachment(mime: &str, name: &str) -> Attachment {
    Attachment {
        a_type: AttachmentType::Inline(vec![1, 2, 3]),
        part: 0,
        uti_type: "public.heic".into(),
        mime: mime.into(),
        name: name.into(),
        iris: false,
    }
}

fn app(bundle: &str) -> Option<ExtensionApp> {
    Some(ExtensionApp {
        name: "App".into(),
        app_id: None,
        bundle_id: bundle.into(),
        balloon: None,
    })
}

#[test]
fn outgoing_messages_use_the_explicit_sender_and_requested_guid() {
    let message = text(US, THEM, "GUID-1", "hello");
    assert_eq!(message.id, "GUID-1");
    assert_eq!(message.sender.as_deref(), Some(US));
    assert_eq!(message.conversation.unwrap().participants, vec![US, THEM]);
    assert!(matches!(
        message.message,
        Message::Message(NormalMessage {
            service: MessageType::IMessage,
            ..
        })
    ));
    assert!(matches!(
        typing(US, THEM, false).message,
        Message::Typing(false, None)
    ));
    let receipt = read(US, THEM, "GUID-2");
    assert_eq!(receipt.id, "GUID-2");
    assert!(matches!(receipt.message, Message::Read));
    for (name, _) in TAPBACKS {
        let reacted = react(US, THEM, "GUID-3", name, "quoted").unwrap();
        let Message::React(reaction) = reacted.message else {
            panic!("not a reaction");
        };
        assert_eq!(
            (reaction.to_uuid.as_str(), reaction.to_part),
            ("GUID-3", Some(0))
        );
        assert_eq!(reaction.to_text, "quoted");
        assert!(matches!(
            reaction.reaction,
            ReactMessageType::React { enable: true, .. }
        ));
    }
    assert!(react(US, THEM, "GUID-3", "unknown", "quoted").is_none());
}

#[test]
fn incoming_text_keeps_participants_attachments_replies_and_payloads() {
    let mut body = NormalMessage::new(String::new(), MessageType::IMessage);
    body.parts = MessageParts(vec![
        part(MessagePart::Text("look ".into(), TextFormat::default())),
        part(MessagePart::Mention(
            "mailto:a@example.test".into(),
            "Ann".into(),
        )),
        part(MessagePart::Attachment(attachment(
            "image/heic",
            "IMG 1.HEIC",
        ))),
        part(MessagePart::Object("object".into())),
        part(MessagePart::Attachment(attachment(
            "video/quicktime",
            "clip",
        ))),
    ]);
    body.reply_guid = Some("ORIGINAL".into());
    body.app = app("com.apple.findmy.Location");
    let message = incoming(Message::Message(body));
    let found = attachments(&message);
    assert_eq!(found.len(), 2);
    assert!(wanted(found[0]) && !wanted(found[1]));
    assert_eq!(
        file_name(&message.id, 0, found[0]),
        format!("{}-0.heic", message.id)
    );
    assert_eq!(file_name("../GUID", 1, found[1]), "GUID-1");
    let event = event(&message, &[Some("/state/a.heic".into())]).unwrap();
    assert_eq!(
        event,
        json!({
            "guid": message.id, "sender": THEM, "participants": [THEM, US],
            "sentAt": 1_700_000_000_123u64, "kind": "text", "text": "look Ann",
            "attachments": [
                {"path": "/state/a.heic", "mime": "image/heic", "uti": "public.heic"},
                {"path": null, "mime": "video/quicktime", "uti": "public.heic"},
            ],
            "replyTo": "ORIGINAL", "payload": "location",
        })
    );
}

#[test]
fn payload_distinguishes_links_locations_and_apps() {
    for (bundle, expected) in [
        (None, Value::Null),
        (Some("com.apple.messages.URLBalloonProvider"), Value::Null),
        (
            Some("com.apple.messages.MSMessageExtensionBalloonPlugin:poll"),
            json!("app"),
        ),
    ] {
        let mut body = NormalMessage::new("x".into(), MessageType::IMessage);
        body.app = bundle.and_then(app);
        assert_eq!(
            event(&incoming(Message::Message(body)), &[]).unwrap()["payload"],
            expected
        );
    }
    assert!(attachments(&incoming(Message::Read)).is_empty());
}

#[test]
fn reactions_edits_unsends_and_receipts_become_gateway_events() {
    let mut expected = TAPBACKS.map(|(_, emoji)| emoji.to_owned()).to_vec();
    expected.extend(["🔥".to_owned(), "sticker".to_owned()]);
    let reactions = [
        Reaction::Heart,
        Reaction::Like,
        Reaction::Dislike,
        Reaction::Laugh,
        Reaction::Emphasize,
        Reaction::Question,
        Reaction::Emoji("🔥".into()),
        Reaction::Sticker {
            spec: None,
            body: MessageParts(vec![]),
        },
    ];
    for (reaction, emoji) in reactions.into_iter().zip(expected) {
        let message = incoming(Message::React(ReactMessage {
            to_uuid: "TARGET".into(),
            to_part: Some(0),
            to_text: String::new(),
            reaction: ReactMessageType::React {
                reaction,
                enable: false,
            },
            embedded_profile: None,
        }));
        let event = event(&message, &[]).unwrap();
        assert_eq!(
            (
                &event["kind"],
                &event["target"],
                &event["emoji"],
                &event["added"]
            ),
            (
                &json!("tapback"),
                &json!("TARGET"),
                &json!(emoji),
                &json!(false)
            )
        );
    }
    let edit = incoming(Message::Edit(EditMessage {
        tuuid: "TARGET".into(),
        edit_part: 0,
        new_parts: MessageParts(vec![part(MessagePart::Text(
            "fixed".into(),
            TextFormat::default(),
        ))]),
    }));
    assert_eq!(event(&edit, &[]).unwrap()["text"], "fixed");
    let unsend = incoming(Message::Unsend(UnsendMessage {
        tuuid: "TARGET".into(),
        edit_part: 0,
    }));
    assert_eq!(event(&unsend, &[]).unwrap()["kind"], "unsend");
    assert_eq!(
        event(&incoming(Message::Delivered), &[]).unwrap()["kind"],
        "delivered"
    );
    assert_eq!(
        event(&incoming(Message::Read), &[]).unwrap()["kind"],
        "read"
    );
    let mut sms = NormalMessage::new("sms".into(), MessageType::IMessage);
    sms.service = MessageType::SMS {
        is_phone: true,
        using_number: THEM.into(),
        from_handle: None,
    };
    assert!(event(&incoming(Message::Message(sms)), &[]).is_none());
    assert!(event(&incoming(Message::Typing(true, None)), &[]).is_none());
    let mut detached = incoming(Message::Delivered);
    detached.conversation = None;
    assert_eq!(event(&detached, &[]).unwrap()["participants"], Value::Null);
}
