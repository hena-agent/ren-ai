use crate::diagnostics::Failure;
use rustpush::{MessageInst, PushError, SendResult};
use tokio::sync::broadcast;
use tokio_util::task::AbortOnDropHandle;

#[derive(Debug, PartialEq)]
pub enum Delivery {
    Sent,
    Failed(&'static str),
    Rejected(Vec<i64>),
}

pub fn recipient(message: &MessageInst) -> Result<String, Failure> {
    let sender = message
        .sender
        .as_ref()
        .ok_or_else(|| Failure::new("input", "missing_sender"))?;
    let conversation = message
        .conversation
        .as_ref()
        .ok_or_else(|| Failure::new("input", "missing_conversation"))?;
    conversation
        .participants
        .iter()
        .find(|p| *p != sender)
        .cloned()
        .ok_or_else(|| Failure::new("input", "missing_recipient"))
}

pub async fn submitted<T: Clone>(
    recipient: &str,
    no_reply: bool,
    result: Result<broadcast::Receiver<(T, SendResult)>, PushError>,
    participant: impl Fn(&T) -> String,
    completion: Option<AbortOnDropHandle<Result<(), PushError>>>,
) -> Result<Delivery, Failure> {
    let results = match result {
        Err(PushError::NoValidTargets) => return Ok(Delivery::Failed("no_imessage")),
        Err(error) => return Err(Failure::push("send", error)),
        Ok(results) => results,
    };
    let outcome = if no_reply {
        Ok(Delivery::Sent)
    } else {
        outcome(recipient, results, participant).await
    };
    // A closed result channel is not proof that every device answered: the task may have failed.
    // No-reply operations also require the submission task to finish successfully.
    if no_reply || !matches!(outcome, Ok(Delivery::Sent)) {
        if let Some(task) = completion {
            task.await
                .map_err(|_| Failure::new("send", "submission_task_failed"))?
                .map_err(|error| Failure::push("send", error))?;
        }
    }
    outcome
}

/// Any recipient device accepting the message sends it; only unanimous rejection fails it.
pub async fn outcome<T: Clone>(
    recipient: &str,
    mut results: broadcast::Receiver<(T, SendResult)>,
    participant: impl Fn(&T) -> String,
) -> Result<Delivery, Failure> {
    let (mut rejected, mut unconfirmed) = (Vec::new(), false);
    loop {
        let (target, result) = match results.recv().await {
            Ok(item) => item,
            Err(broadcast::error::RecvError::Lagged(_)) => {
                unconfirmed = true;
                continue;
            }
            Err(broadcast::error::RecvError::Closed) => break,
        };
        if participant(&target) != recipient {
            continue;
        }
        match result {
            SendResult::Sent => return Ok(Delivery::Sent),
            SendResult::APSError(code) => rejected.push(code),
            SendResult::TimedOut => unconfirmed = true,
        }
    }
    if !rejected.is_empty() && !unconfirmed {
        Ok(Delivery::Rejected(rejected))
    } else {
        Err(Failure::new("send", "unconfirmed"))
    }
}

#[cfg(test)]
#[path = "delivery_tests.rs"]
mod tests;
