use super::*;
use std::time::Duration;

#[tokio::test]
async fn submissions_distinguish_rejection_uncertainty_and_no_reply_operations() {
    for (error, expected) in [
        (
            PushError::NoValidTargets,
            Ok(Delivery::Failed("no_imessage")),
        ),
        (PushError::BadMsg, Err("send")),
    ] {
        assert_eq!(
            submitted::<String>("them", false, Err(error), String::clone, None)
                .await
                .map_err(|e| e.stage),
            expected
        );
    }
    let (_, results) = broadcast::channel::<(String, SendResult)>(1);
    assert_eq!(
        submitted("them", true, Ok(results), String::clone, None)
            .await
            .unwrap(),
        Delivery::Sent
    );
    let (sender, results) = broadcast::channel(1);
    assert!(sender.send(("them".to_owned(), SendResult::Sent)).is_ok());
    assert_eq!(
        submitted("them", false, Ok(results), String::clone, None)
            .await
            .unwrap(),
        Delivery::Sent
    );
}

#[tokio::test]
async fn partial_rejection_followed_by_submission_failure_remains_uncertain() {
    let (sender, results) = broadcast::channel(2);
    assert!(sender
        .send(("them".to_owned(), SendResult::APSError(5000)))
        .is_ok());
    drop(sender);
    let task = AbortOnDropHandle::new(tokio::spawn(async { Err(PushError::APSAckError(7)) }));
    let failure = submitted("them", false, Ok(results), String::clone, Some(task))
        .await
        .unwrap_err();
    assert_eq!(failure.stage, "send");
    assert_eq!(failure.cause["code"], 7);
}

#[tokio::test]
async fn unanimous_rejection_requires_successful_completion_and_cancellation_stops_work() {
    for panic in [false, true] {
        let (sender, results) = broadcast::channel(1);
        assert!(sender
            .send(("them".to_owned(), SendResult::APSError(5000)))
            .is_ok());
        drop(sender);
        let task = AbortOnDropHandle::new(tokio::spawn(async move {
            assert!(!panic, "synthetic task failure");
            Ok(())
        }));
        let result = submitted("them", false, Ok(results), String::clone, Some(task)).await;
        if panic {
            assert_eq!(result.unwrap_err().cause["code"], "submission_task_failed");
        } else {
            assert_eq!(result.unwrap(), Delivery::Rejected(vec![5000]));
        }
    }
    let (sender, results) = broadcast::channel::<(String, SendResult)>(1);
    let task = AbortOnDropHandle::new(tokio::spawn(async move {
        let _keep_open = sender;
        std::future::pending::<Result<(), PushError>>().await
    }));
    let aborted = task.abort_handle();
    assert!(tokio::time::timeout(
        Duration::from_millis(1),
        submitted("them", false, Ok(results), String::clone, Some(task))
    )
    .await
    .is_err());
    while !aborted.is_finished() {
        tokio::task::yield_now().await;
    }
}

#[test]
fn recipient_selection_requires_an_explicit_sender_and_other_participant() {
    let mut message = crate::codec::text("us", "them", "id", "private");
    assert_eq!(recipient(&message).unwrap(), "them");
    message.conversation.as_mut().unwrap().participants = vec!["us".into()];
    assert_eq!(
        recipient(&message).unwrap_err().cause["code"],
        "missing_recipient"
    );
    message.conversation = None;
    assert_eq!(
        recipient(&message).unwrap_err().cause["code"],
        "missing_conversation"
    );
    message.sender = None;
    assert_eq!(
        recipient(&message).unwrap_err().cause["code"],
        "missing_sender"
    );
}
