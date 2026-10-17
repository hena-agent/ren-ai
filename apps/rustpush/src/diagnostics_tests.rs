use super::*;
use rustpush::{IDSError, ResourceFailure};
use std::sync::Arc;

fn http_error() -> reqwest::Error {
    reqwest::Client::new()
        .get("http://[::1")
        .build()
        .unwrap_err()
}

#[test]
fn nested_provider_failures_retain_codes_and_exclude_private_payloads() {
    let error = PushError::DoNotRetry(Box::new(PushError::CircleHTTPError(
        icloud_auth::Error::AuthSrpWithMessage(6001, "private account and credential echo".into()),
    )));
    let failure = Failure::push("register", error);
    assert_eq!(failure.cause["code"], 6001);
    assert_eq!(failure.cause["kind"], "apple_auth");
    assert!(!failure.cause.to_string().contains("private"));
    let error = PushError::IoError(std::io::Error::other(nac_validation::NacError::NacFailed {
        code: 42,
        message: "private hardware data".into(),
    }));
    let failure = Failure::push("validation", error);
    assert_eq!(failure.cause["code"], 42);
    assert!(!failure.cause.to_string().contains("private"));
}

#[test]
fn every_classified_provider_failure_keeps_only_its_code_and_kind() {
    let wrapped = |error| {
        PushError::ResourceFailure(ResourceFailure {
            retry_wait: Some(1),
            error: Arc::new(error),
        })
    };
    let cases = [
        (
            wrapped(PushError::APSConnectError(7)),
            json!({"kind": "apns_connect", "code": 7}),
        ),
        (
            PushError::BatchError(Arc::new(PushError::APSAckError(8))),
            json!({"kind": "apns_ack", "code": 8}),
        ),
        (
            PushError::RegisterFailed(IDSError(6001)),
            json!({"kind": "ids_registration", "code": 6001}),
        ),
        (
            PushError::AuthInvalid(IDSError(6005)),
            json!({"kind": "ids_auth", "code": 6005}),
        ),
        (
            PushError::LookupFailed(IDSError(5206)),
            json!({"kind": "ids_lookup", "code": 5206}),
        ),
        (PushError::SendErr(-1), json!({"kind": "send", "code": -1})),
        (
            PushError::NoValidTargets,
            json!({"kind": "no_valid_targets"}),
        ),
        (
            PushError::AlbertCertParseError,
            json!({"kind": "activation_certificate_missing"}),
        ),
        (
            PushError::RequestError(http_error()),
            json!({"kind": "http", "status": null, "timeout": false, "connect": false}),
        ),
        (
            PushError::StatusError(reqwest::StatusCode::IM_A_TEAPOT),
            json!({"kind": "http", "status": 418}),
        ),
        (
            PushError::IoError(std::io::Error::from_raw_os_error(2)),
            json!({"kind": "io", "io_kind": "NotFound", "os_code": 2}),
        ),
        (
            PushError::CircleHTTPError(icloud_auth::Error::Bad2faCode),
            json!({"kind": "invalid_verification_code"}),
        ),
        (
            PushError::CircleHTTPError(icloud_auth::Error::ExtraStep("private".into())),
            json!({"kind": "account_requires_web_sign_in"}),
        ),
        (
            PushError::CircleHTTPError(icloud_auth::Error::HardwareKeyError),
            json!({"kind": "hardware_security_key_required"}),
        ),
        (
            PushError::CircleHTTPError(icloud_auth::Error::ReqwestError(http_error())),
            json!({"kind": "apple_auth_http", "status": null, "timeout": false, "connect": false}),
        ),
    ];
    for (error, expected) in cases {
        assert_eq!(Failure::push("stage", error).cause, expected);
    }
    let other = Failure::push(
        "stage",
        PushError::CircleHTTPError(icloud_auth::Error::Parse),
    );
    assert_eq!(other.cause["kind"], "apple_auth");
    assert!(other.cause["variant"].is_string());
    let unknown = Failure::push("stage", PushError::BadMsg);
    assert_eq!(unknown.cause["kind"], "rustpush");
    let io = Failure::io("stage", std::io::Error::other("private path"));
    assert_eq!(io.cause, json!({"kind": "Other", "os_code": null}));
}

#[tokio::test]
async fn http_failures_retain_status_without_echoing_urls_or_bodies() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        for _ in 0..2 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            assert!(socket.read(&mut request).await.unwrap() > 0);
            socket.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 12\r\nConnection: close\r\n\r\nprivate body").await.unwrap();
        }
    });
    for apple in [false, true] {
        let error = reqwest::get(format!("http://{address}/private?token=secret"))
            .await
            .unwrap()
            .error_for_status()
            .unwrap_err();
        let error = if apple {
            PushError::CircleHTTPError(icloud_auth::Error::ReqwestError(error))
        } else {
            PushError::RequestError(error)
        };
        let cause = Failure::push("request", error).cause;
        assert_eq!(cause["status"], 503);
        assert!(!cause.to_string().contains("private"));
        assert!(!cause.to_string().contains("secret"));
    }
    server.await.unwrap();
}
