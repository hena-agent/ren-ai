use super::*;

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
            submitted::<String>("them", false, Err(error), String::clone)
                .await
                .map_err(|e| e.stage),
            expected
        );
    }
    let (_, results) = broadcast::channel::<(String, SendResult)>(1);
    assert_eq!(
        submitted("them", true, Ok(results), String::clone)
            .await
            .unwrap(),
        Delivery::Sent
    );
    let (sender, results) = broadcast::channel(1);
    assert!(sender.send(("them".to_owned(), SendResult::Sent)).is_ok());
    assert_eq!(
        submitted("them", false, Ok(results), String::clone)
            .await
            .unwrap(),
        Delivery::Sent
    );
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
