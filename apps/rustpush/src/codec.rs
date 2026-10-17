use rustpush::{
    Attachment, ConversationData, Message, MessageInst, MessagePart, MessageType, NormalMessage,
    ReactMessage, ReactMessageType, Reaction,
};
use serde_json::{json, Value};

/// The tapback names of the gateway protocol, in Apple's reaction order.
const TAPBACKS: [(&str, &str); 6] = [
    ("love", "❤️"),
    ("like", "👍"),
    ("dislike", "👎"),
    ("laugh", "😂"),
    ("emphasis", "‼️"),
    ("question", "❓"),
];

fn reaction(name: &str) -> Option<Reaction> {
    Some(match name {
        "love" => Reaction::Heart,
        "like" => Reaction::Like,
        "dislike" => Reaction::Dislike,
        "laugh" => Reaction::Laugh,
        "emphasis" => Reaction::Emphasize,
        "question" => Reaction::Question,
        _ => return None,
    })
}

fn emoji(reaction: &Reaction) -> String {
    let index = match reaction {
        Reaction::Heart => 0,
        Reaction::Like => 1,
        Reaction::Dislike => 2,
        Reaction::Laugh => 3,
        Reaction::Emphasize => 4,
        Reaction::Question => 5,
        Reaction::Emoji(emoji) => return emoji.clone(),
        Reaction::Sticker { .. } => return "sticker".into(),
    };
    TAPBACKS[index].1.into()
}

fn conversation(from: &str, to: &str) -> ConversationData {
    ConversationData {
        participants: vec![from.to_owned(), to.to_owned()],
        cv_name: None,
        sender_guid: None,
        after_guid: None,
    }
}

pub fn text(from: &str, to: &str, guid: &str, body: &str) -> MessageInst {
    let mut message = MessageInst::new(
        conversation(from, to),
        from,
        Message::Message(NormalMessage::new(body.to_owned(), MessageType::IMessage)),
    );
    message.id = guid.to_owned();
    message
}

pub fn typing(from: &str, to: &str, active: bool) -> MessageInst {
    MessageInst::new(conversation(from, to), from, Message::Typing(active, None))
}

/// A read receipt carries the GUID of the latest message it marks read.
pub fn read(from: &str, to: &str, guid: &str) -> MessageInst {
    let mut message = MessageInst::new(conversation(from, to), from, Message::Read);
    message.id = guid.to_owned();
    message
}

pub fn react(from: &str, to: &str, guid: &str, name: &str, quoted: &str) -> Option<MessageInst> {
    let reaction = ReactMessage {
        to_uuid: guid.to_owned(),
        to_part: Some(0),
        to_text: quoted.to_owned(),
        reaction: ReactMessageType::React {
            reaction: reaction(name)?,
            enable: true,
        },
        embedded_profile: None,
    };
    Some(MessageInst::new(
        conversation(from, to),
        from,
        Message::React(reaction),
    ))
}

/// Attachment parts in message order; the saved paths passed to `event` follow this order.
pub fn attachments(message: &MessageInst) -> Vec<&Attachment> {
    let Message::Message(normal) = &message.message else {
        return vec![];
    };
    normal
        .parts
        .0
        .iter()
        .filter_map(|part| match &part.part {
            MessagePart::Attachment(attachment) => Some(attachment),
            _ => None,
        })
        .collect()
}

/// Only images are rendered for a persona; other attachments stay placeholders.
pub fn wanted(attachment: &Attachment) -> bool {
    attachment.mime.starts_with("image/")
}

pub fn file_name(guid: &str, index: usize, attachment: &Attachment) -> String {
    let extension: String = attachment
        .name
        .rsplit_once('.')
        .map(|(_, extension)| extension)
        .unwrap_or("")
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(8)
        .collect();
    let guid: String = guid
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    if extension.is_empty() {
        format!("{guid}-{index}")
    } else {
        format!("{guid}-{index}.{}", extension.to_ascii_lowercase())
    }
}

fn plain(parts: &rustpush::MessageParts) -> String {
    parts
        .0
        .iter()
        .filter_map(|part| match &part.part {
            MessagePart::Text(text, _) | MessagePart::Mention(_, text) => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

fn payload(normal: &NormalMessage) -> Value {
    let Some(app) = &normal.app else {
        return Value::Null;
    };
    let bundle = app.bundle_id.to_ascii_lowercase();
    if bundle == "com.apple.messages.urlballoonprovider" {
        Value::Null
    } else if bundle.contains("location") || bundle.contains("findmy") {
        json!("location")
    } else {
        json!("app")
    }
}

fn normal(normal: &NormalMessage, saved: &[Option<String>]) -> Value {
    let attachments: Vec<Value> = normal
        .parts
        .0
        .iter()
        .filter_map(|part| match &part.part {
            MessagePart::Attachment(attachment) => Some(attachment),
            _ => None,
        })
        .enumerate()
        .map(|(index, attachment)| {
            json!({
                "path": saved.get(index).cloned().flatten(),
                "mime": attachment.mime, "uti": attachment.uti_type,
            })
        })
        .collect();
    json!({
        "kind": "text", "text": plain(&normal.parts), "attachments": attachments,
        "replyTo": normal.reply_guid, "payload": payload(normal),
    })
}

fn content(message: &MessageInst, saved: &[Option<String>]) -> Option<Value> {
    Some(match &message.message {
        Message::Message(body) if body.service == MessageType::IMessage => normal(body, saved),
        Message::React(ReactMessage {
            to_uuid,
            reaction: ReactMessageType::React { reaction, enable },
            ..
        }) => json!({
            "kind": "tapback", "target": to_uuid, "emoji": emoji(reaction), "added": enable,
        }),
        Message::Edit(edit) => {
            json!({"kind": "edit", "target": edit.tuuid, "text": plain(&edit.new_parts)})
        }
        Message::Unsend(unsend) => json!({"kind": "unsend", "target": unsend.tuuid}),
        Message::Delivered => json!({"kind": "delivered"}),
        Message::Read => json!({"kind": "read"}),
        _ => return None,
    })
}

/// The gateway's view of a decoded notification; None for kinds the gateway never stores.
pub fn event(message: &MessageInst, saved: &[Option<String>]) -> Option<Value> {
    let mut event = content(message, saved)?;
    event["guid"] = json!(message.id);
    event["sender"] = json!(message.sender);
    event["participants"] = json!(message
        .conversation
        .as_ref()
        .map(|conversation| &conversation.participants));
    event["sentAt"] = json!(message.sent_timestamp);
    Some(event)
}

#[cfg(test)]
#[path = "codec_tests.rs"]
mod tests;
