use crate::{codec, delivery::Delivery, diagnostics::Failure, store::Store};
use rustpush::{APSMessage, Attachment, Message, MessageInst};
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    fs::File,
    future::Future,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt},
    sync::{mpsc, oneshot},
    task::JoinSet,
};

#[path = "rpc_availability.rs"]
mod availability;
#[path = "rpc_image.rs"]
mod image;

/// The Apple session behind the bridge. An `Err` from `send` means the outcome is uncertain.
pub trait Native: Send + Sync + 'static {
    fn availability(
        &self,
        from: &str,
        to: &str,
    ) -> impl Future<Output = Result<bool, Failure>> + Send;
    fn handles(&self) -> impl Future<Output = Result<Vec<String>, Failure>> + Send;
    fn decode(
        &self,
        raw: APSMessage,
    ) -> impl Future<Output = Result<Option<MessageInst>, Failure>> + Send;
    fn certify(&self, message: &MessageInst) -> impl Future<Output = Result<(), Failure>> + Send;
    fn download(
        &self,
        attachment: &Attachment,
        file: &mut File,
    ) -> impl Future<Output = Result<(), Failure>> + Send;
    fn send(&self, message: MessageInst) -> impl Future<Output = Result<Delivery, Failure>> + Send;
    fn upload(&self, jpeg: &[u8]) -> impl Future<Output = Result<Attachment, Failure>> + Send;
}

pub struct Timing {
    pub ack: Duration,
    pub rescan: Duration,
    pub download_retry: Duration,
}

pub const TIMING: Timing = Timing {
    ack: Duration::from_secs(30),
    rescan: Duration::from_secs(300),
    download_retry: Duration::from_secs(2),
};

type Acks = Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>;
type Output = mpsc::UnboundedSender<Value>;
const NOTIFICATION_HANDLE: &str = "mailto:noti@renai.im";

#[derive(Deserialize)]
struct Request {
    #[serde(rename = "requestId")]
    request_id: uuid::Uuid,
    id: u64,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Text {
    from: String,
    guid: String,
    to: String,
    text: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Typing {
    to: String,
    active: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Read {
    to: String,
    guid: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct React {
    to: String,
    guid: String,
    tapback: String,
    text: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Ack {
    spool: String,
}

pub fn report(level: &str, operation: &str, request_id: &str, failure: &Failure) {
    eprintln!(
        "{}",
        json!({
            "level": level, "service": "rustpush", "request_id": request_id,
            "operation": operation, "stage": failure.stage, "cause": failure.cause,
        })
    );
}

fn params<T: DeserializeOwned>(value: Value) -> Result<T, Failure> {
    serde_json::from_value(value).map_err(|_| Failure::new("input", "invalid_params"))
}

fn recipient(to: &str, from: &str) -> Result<(), Failure> {
    let valid = to.starts_with("mailto:") || to.starts_with("tel:+");
    if valid && to != from {
        Ok(())
    } else {
        Err(Failure::new("input", "invalid_recipient"))
    }
}

// Upstream parses outgoing IDs as UUIDs and panics on anything else.
fn guid(value: &str) -> Result<(), Failure> {
    uuid::Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| Failure::new("input", "invalid_guid"))
}

fn delivery(delivery: Delivery) -> Value {
    match delivery {
        Delivery::Sent => json!({"status": "sent"}),
        Delivery::Failed(code) => json!({"status": "failed", "code": code}),
        Delivery::Rejected(codes) => {
            json!({"status": "failed", "code": "rejected", "providerCodes": codes})
        }
    }
}

async fn sender<N: Native>(native: &N, from: &str) -> Result<(), Failure> {
    if from != crate::command::SERVICE_HANDLE && from != NOTIFICATION_HANDLE {
        return Err(Failure::new("input", "invalid_sender"));
    }
    let handles = native.handles().await.map_err(|failure| Failure {
        stage: "input",
        cause: json!({"code": "sender_unavailable", "upstreamStage": failure.stage, "upstream": failure.cause}),
    })?;
    if !handles.iter().any(|handle| handle == from) {
        return Err(Failure::new("input", "sender_not_registered"));
    }
    Ok(())
}

async fn call<N: Native>(
    native: &N,
    from: &str,
    method: &str,
    input: Value,
) -> Result<Value, Failure> {
    let message = match method {
        "handles" => return Ok(json!({"handles": native.handles().await?})),
        "availability" => return availability::call(native, from, input).await,
        "send_image" => return image::call(native, input).await,
        "send" => {
            let p: Text = params(input)?;
            guid(&p.guid)?;
            recipient(&p.to, &p.from)?;
            sender(native, &p.from).await?;
            codec::text(&p.from, &p.to, &p.guid, &p.text)
        }
        "typing" => {
            let p: Typing = params(input)?;
            recipient(&p.to, from)?;
            codec::typing(from, &p.to, p.active)
        }
        "read" => {
            let p: Read = params(input)?;
            guid(&p.guid)?;
            recipient(&p.to, from)?;
            codec::read(from, &p.to, &p.guid)
        }
        "react" => {
            let p: React = params(input)?;
            recipient(&p.to, from)?;
            codec::react(from, &p.to, &p.guid, &p.tapback, &p.text)
                .ok_or_else(|| Failure::new("input", "unknown_tapback"))?
        }
        _ => return Err(Failure::new("input", "unknown_method")),
    };
    native.send(message).await.map(delivery)
}

fn reply(id: u64, result: Result<Value, Failure>, request_id: &str) -> Value {
    match result {
        Ok(result) => json!({"id": id, "result": result}),
        Err(failure) => {
            json!({"id": id, "error": {"stage": failure.stage, "cause": failure.cause, "requestId": request_id}})
        }
    }
}

async fn download<N: Native>(
    native: &N,
    store: &Store,
    name: &str,
    attachment: &Attachment,
    timing: &Timing,
    request_id: &str,
) -> Result<String, Failure> {
    let path = store.attachment(name)?;
    if path.exists() {
        return Ok(path.to_string_lossy().into_owned());
    }
    let mut attempt = 0;
    loop {
        let result = async {
            let mut file = store.partial(&path)?;
            native.download(attachment, &mut file).await?;
            store.commit(file, &path)
        }
        .await;
        match result {
            Ok(()) => return Ok(path.to_string_lossy().into_owned()),
            Err(failure) if attempt == 2 => return Err(failure),
            Err(failure) => report("warn", "attachment", request_id, &failure),
        }
        tokio::time::sleep(timing.download_retry * 2u32.pow(attempt)).await;
        attempt += 1;
    }
}

async fn saved<N: Native>(
    native: &N,
    store: &Store,
    message: &MessageInst,
    timing: &Timing,
    request_id: &str,
) -> Result<Vec<Option<String>>, Failure> {
    let mut paths = Vec::new();
    for (index, attachment) in codec::attachments(message).into_iter().enumerate() {
        paths.push(if codec::wanted(attachment) {
            let name = codec::file_name(&message.id, index, attachment);
            Some(download(native, store, &name, attachment, timing, request_id).await?)
        } else {
            None
        });
    }
    Ok(paths)
}

/// Re-emits until the gateway confirms the event is durable.
async fn deliver(
    spool: &str,
    message: Value,
    output: &Output,
    acks: &Acks,
    timing: &Timing,
) -> Result<(), Failure> {
    let event = json!({"event": "message", "spool": spool, "message": message});
    loop {
        let (sender, receiver) = oneshot::channel();
        acks.lock()
            .expect("ack registry poisoned")
            .insert(spool.to_owned(), sender);
        output
            .send(event.clone())
            .map_err(|_| Failure::new("gateway", "output_closed"))?;
        if matches!(tokio::time::timeout(timing.ack, receiver).await, Ok(Ok(()))) {
            return Ok(());
        }
    }
}

struct Inbound<N> {
    native: Arc<N>,
    store: Arc<Store>,
    output: Output,
    acks: Acks,
    timing: Timing,
    request_id: String,
}

fn addressed_to_service(raw: &APSMessage) -> bool {
    let APSMessage::Notification { payload, .. } = raw else {
        return false;
    };
    payload
        .as_dictionary()
        .and_then(|fields| fields.get("tP"))
        .and_then(plist::Value::as_string)
        .is_some_and(|target| target.eq_ignore_ascii_case(crate::command::SERVICE_HANDLE))
}

impl<N: Native> Inbound<N> {
    // A notification leaves the spool only after the gateway stored it and Apple was told.
    async fn process(&self, spool: &str) -> Result<(), Failure> {
        let Some(raw) = self.store.load::<APSMessage>(spool)? else {
            return Ok(());
        };
        let for_service = addressed_to_service(&raw);
        if let Some(message) = self.native.decode(raw).await? {
            // Notification replies have no inbox. Discard before saving their attachments;
            // raw APNs state is still removed only after delivery certification succeeds.
            if !for_service && !matches!(message.message, Message::Delivered | Message::Read) {
                self.native.certify(&message).await?;
                return self.store.remove(spool);
            }
            let paths = saved(
                &*self.native,
                &self.store,
                &message,
                &self.timing,
                &self.request_id,
            )
            .await?;
            if let Some(event) = codec::event(&message, &paths) {
                deliver(spool, event, &self.output, &self.acks, &self.timing).await?;
            }
            self.native.certify(&message).await?;
        }
        self.store.remove(spool)
    }

    async fn run(self, mut queue: VecDeque<String>, mut inbox: mpsc::UnboundedReceiver<String>) {
        let mut rescan = tokio::time::interval(self.timing.rescan);
        rescan.tick().await;
        loop {
            let spool = match queue.pop_front() {
                Some(spool) => spool,
                None => tokio::select! {
                    spool = inbox.recv() => match spool {
                        Some(spool) => spool,
                        None => return,
                    },
                    _ = rescan.tick() => {
                        match self.store.pending() {
                            Ok(pending) => queue.extend(pending),
                            Err(failure) => report("error", "inbound", &self.request_id, &failure),
                        }
                        continue;
                    }
                },
            };
            if let Err(failure) = self.process(&spool).await {
                report("error", "inbound", &self.request_id, &failure);
            }
        }
    }
}

async fn write(mut output: impl AsyncWrite + Unpin, mut lines: mpsc::UnboundedReceiver<Value>) {
    while let Some(line) = lines.recv().await {
        let bytes = format!("{line}\n");
        if output.write_all(bytes.as_bytes()).await.is_err() || output.flush().await.is_err() {
            return;
        }
    }
}

pub struct Session<N> {
    pub native: Arc<N>,
    pub store: Arc<Store>,
    pub handle: String,
    pub pending: VecDeque<String>,
    pub inbox: mpsc::UnboundedReceiver<String>,
}

/// Serves requests until the gateway closes standard input.
pub async fn serve<N: Native>(
    session: Session<N>,
    input: impl AsyncBufRead + Unpin,
    output: impl AsyncWrite + Unpin + Send + 'static,
    timing: Timing,
    request_id: &str,
) {
    let (sender, lines) = mpsc::unbounded_channel();
    let mut writer = tokio::spawn(write(output, lines));
    let acks: Acks = Arc::default();
    let inbound = Inbound {
        native: session.native.clone(),
        store: session.store,
        output: sender.clone(),
        acks: acks.clone(),
        timing,
        request_id: request_id.to_owned(),
    };
    let mut receiver = tokio::spawn(inbound.run(session.pending, session.inbox));
    let mut requests = input.lines();
    let mut jobs = JoinSet::new();
    loop {
        let line = tokio::select! {
            line = requests.next_line() => match line {
                Ok(Some(line)) => line,
                _ => break,
            },
            _ = &mut writer => break,
            _ = &mut receiver => break,
            _ = jobs.join_next(), if !jobs.is_empty() => continue,
        };
        let Ok(request) = serde_json::from_str::<Request>(&line) else {
            report(
                "warn",
                "request",
                request_id,
                &Failure::new("input", "invalid_request"),
            );
            continue;
        };
        if request.method == "ack" {
            let request_id = request.request_id.to_string();
            let result = params::<Ack>(request.params).map(|ack| {
                let waiting = acks
                    .lock()
                    .expect("ack registry poisoned")
                    .remove(&ack.spool);
                json!({"acknowledged": waiting.is_some_and(|waiting| waiting.send(()).is_ok())})
            });
            if let Err(failure) = &result {
                report("warn", "ack", &request_id, failure);
            }
            let _ = sender.send(reply(request.id, result, &request_id));
            continue;
        }
        let (native, handle, sender) = (
            session.native.clone(),
            session.handle.clone(),
            sender.clone(),
        );
        jobs.spawn(async move {
            let request_id = request.request_id.to_string();
            let started = Instant::now();
            let operation = match request.method.as_str() {
                "handles" | "availability" | "send" | "send_image" | "typing" | "read" | "react" => request.method.as_str(),
                _ => "unknown",
            };
            let result = tokio::time::timeout(
                Duration::from_secs(120),
                call(&*native, &handle, &request.method, request.params),
            )
            .await
            .unwrap_or_else(|_| Err(Failure::new("request", "timeout_outcome_uncertain")));
            if let Err(failure) = &result {
                report(
                    if failure.stage == "input" {
                        "warn"
                    } else {
                        "error"
                    },
                    operation,
                    &request_id,
                    failure,
                );
            }
            let rejected = result.as_ref().is_ok_and(|value| value["status"] == "failed");
            if let Ok(value) = &result {
                if rejected {
                    report(if value["code"] == "attachment_upload_failed" { "error" } else { "warn" }, operation, &request_id, &Failure {
                        stage: if value["code"] == "attachment_upload_failed" { "attachment_upload" } else { "send" },
                        cause: json!({"code": value["code"], "providerCodes": value["providerCodes"], "upstream": value["cause"]}),
                    });
                }
            }
            eprintln!(
                "{}",
                json!({
                    "level": "info", "service": "rustpush", "request_id": request_id,
                    "operation": operation, "stage": "complete",
                    "outcome": if result.is_ok() && !rejected { "success" } else { "failure" },
                    "duration_ms": started.elapsed().as_millis(),
                })
            );
            let _ = sender.send(reply(request.id, result, &request_id));
        });
    }
    // The gateway is gone: nobody can record in-flight outcomes, so stop instead of draining.
    receiver.abort();
    writer.abort();
    jobs.shutdown().await;
}

#[cfg(test)]
#[path = "rpc_tests.rs"]
mod tests;
