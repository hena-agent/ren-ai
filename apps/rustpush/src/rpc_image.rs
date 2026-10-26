use super::{delivery, guid, params, recipient, sender, Native};
use crate::diagnostics::Failure;
use rustpush::{
    ConversationData, IndexedMessagePart, Message, MessageInst, MessagePart, MessageType,
    NormalMessage,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs::OpenOptions,
    io::Read,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::Path,
    time::Duration,
};

const MAX_BYTES: u64 = 10_000_000;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Image {
    from: String,
    guid: String,
    to: String,
    path: String,
}

pub(super) fn jpeg(path: &str, io: &(dyn crate::io::Io + 'static)) -> Result<Vec<u8>, Failure> {
    if !Path::new(path).is_absolute() {
        return Err(Failure::new("input", "invalid_image_path"));
    }
    // Refuse symlinks and special files without blocking on a FIFO open.
    let file = Failure::io_result(
        "input",
        io.run("image_open", || {
            OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                .open(path)
        }),
    )?;
    let metadata = Failure::io_result("input", io.run("image_metadata", || file.metadata()))?;
    if !metadata.is_file() || metadata.permissions().mode() & 0o077 != 0 {
        return Err(Failure::new("input", "image_not_private_file"));
    }
    let mut bytes = Vec::new();
    Failure::io_result(
        "input",
        io.run("image_read", || {
            file.take(MAX_BYTES + 1).read_to_end(&mut bytes)
        }),
    )?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(Failure::new("input", "image_too_large"));
    }
    // Decode rather than trusting an extension or just the JPEG magic bytes.
    let mut decoder = jpeg_decoder::Decoder::new(bytes.as_slice());
    decoder.set_max_decoding_buffer_size(64 * 1024 * 1024);
    decoder
        .decode()
        .map_err(|_| Failure::new("input", "invalid_jpeg"))?;
    Ok(bytes)
}

pub async fn call<N: Native>(native: &N, input: Value) -> Result<Value, Failure> {
    let p: Image = params(input)?;
    guid(&p.guid)?;
    recipient(&p.to, &p.from)?;
    // Leave time for a definite pre-submission timeout before the outer request deadline.
    let prepared = tokio::time::timeout(Duration::from_secs(90), async {
        sender(native, &p.from).await?;
        let bytes = jpeg(&p.path, &crate::io::System)?;
        native.upload(&bytes).await
    })
    .await
    .unwrap_or_else(|_| Err(Failure::new("attachment_upload", "timeout")));
    let attachment = match prepared {
        Ok(attachment) => attachment,
        Err(failure) if failure.stage == "input" => return Err(failure),
        Err(failure) => {
            return Ok(json!({
                "guid": p.guid, "status": "failed", "code": "attachment_upload_failed",
                "cause": {"stage": failure.stage, "cause": failure.cause},
            }))
        }
    };
    let mut body = NormalMessage::new(String::new(), MessageType::IMessage);
    body.parts.0 = vec![IndexedMessagePart {
        part: MessagePart::Attachment(attachment),
        idx: None,
        ext: None,
    }];
    let conversation = ConversationData {
        participants: vec![p.from.clone(), p.to],
        cv_name: None,
        sender_guid: None,
        after_guid: None,
    };
    let mut message = MessageInst::new(conversation, &p.from, Message::Message(body));
    message.id = p.guid.clone();
    let mut result = delivery(native.send(message).await?);
    result["guid"] = json!(p.guid);
    Ok(result)
}
