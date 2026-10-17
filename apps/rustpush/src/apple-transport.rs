use crate::{
    delivery::{self, Delivery},
    diagnostics::Failure,
    rpc::Native,
};
use rustpush::{APSConnection, APSMessage, Attachment, IMClient, MessageInst};
use std::{fs::File, time::Duration};

/// The live Apple session: the only code that talks to Apple's servers.
pub struct Apple {
    pub client: IMClient,
    pub connection: APSConnection,
}

impl Native for Apple {
    async fn handles(&self) -> Vec<String> {
        self.client.identity.get_handles().await
    }

    async fn decode(&self, raw: APSMessage) -> Result<Option<MessageInst>, Failure> {
        self.client
            .handle(raw)
            .await
            .map_err(|e| Failure::push("decode", e))
    }

    async fn certify(&self, message: &MessageInst) -> Result<(), Failure> {
        let Some(context) = &message.certified_context else {
            return Ok(());
        };
        self.client
            .identity
            .certify_delivery("com.apple.madrid", context, message.send_delivered)
            .await
            .map_err(|e| Failure::push("certify_delivery", e))
    }

    async fn download(&self, attachment: &Attachment, file: &mut File) -> Result<(), Failure> {
        crate::diagnostics::push_with_timeout(
            "attachment_download",
            Duration::from_secs(120),
            attachment.get_attachment(&self.connection, file, |_, _| {}),
        )
        .await
    }

    async fn send(&self, mut message: MessageInst) -> Result<Delivery, Failure> {
        let recipient = delivery::recipient(&message)?;
        let result = self.client.send(&mut message).await.map(|job| job.process);
        delivery::submitted(
            &recipient,
            message.message.get_nr() == Some(true),
            result,
            |target| target.participant.clone(),
        )
        .await
    }
}
