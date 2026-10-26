use crate::{
    delivery::{self, Delivery},
    diagnostics::Failure,
    rpc::Native,
};
use rustpush::{APSConnection, APSMessage, Attachment, IMClient, MMCSFile, MessageInst};
use std::{fs::File, time::Duration};

/// The live Apple session: the only code that talks to Apple's servers.
pub struct Apple {
    pub client: IMClient,
    pub connection: APSConnection,
}

impl Native for Apple {
    async fn availability(&self, from: &str, to: &str) -> Result<bool, Failure> {
        self.client
            .identity
            .validate_targets(&[to.to_owned()], "com.apple.madrid", from)
            .await
            .map(|targets| targets.iter().any(|target| target == to))
            .map_err(|e| Failure::push("ids_lookup", e))
    }

    async fn handles(&self) -> Result<Vec<String>, Failure> {
        let apns = self.connection.resource_state.subscribe();
        let registration = self.client.identity.resource_state.subscribe();
        crate::readiness::probe(apns, registration, async {
            let mut replies = self.connection.subscribe().await;
            self.connection.send(APSMessage::Ping).await?;
            self.connection
                .wait_for(&mut replies, |message| {
                    matches!(message, APSMessage::Pong).then_some(())
                })
                .await
        })
        .await?;
        Ok(self.client.identity.get_handles().await)
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
        let result = self.client.send(&mut message).await;
        let (result, completion) = match result {
            Ok(job) => (Ok(job.process), job.handle),
            Err(error) => (Err(error), None),
        };
        delivery::submitted(
            &recipient,
            message.message.get_nr() == Some(true),
            result,
            |target| target.participant.clone(),
            completion,
        )
        .await
    }

    async fn upload(&self, jpeg: &[u8]) -> Result<Attachment, Failure> {
        let prepared = MMCSFile::prepare_put(jpeg)
            .await
            .map_err(|error| Failure::push("attachment_prepare", error))?;
        Attachment::new_mmcs(
            &self.connection,
            &prepared,
            jpeg,
            "image/jpeg",
            "public.jpeg",
            "photo.jpg",
            |_, _| {},
        )
        .await
        .map_err(|error| Failure::push("attachment_upload", error))
    }
}
