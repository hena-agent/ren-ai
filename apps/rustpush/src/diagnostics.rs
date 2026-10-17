use rustpush::PushError;
use serde_json::{json, Value};

#[derive(Debug)]
pub struct Failure {
    pub stage: &'static str,
    pub cause: Value,
}

impl Failure {
    pub fn new(stage: &'static str, code: &'static str) -> Self {
        Self {
            stage,
            cause: json!({"code": code}),
        }
    }

    pub fn io(stage: &'static str, error: std::io::Error) -> Self {
        Self {
            stage,
            cause: json!({
                "kind": format!("{:?}", error.kind()), "os_code": error.raw_os_error(),
            }),
        }
    }

    pub fn push(stage: &'static str, error: PushError) -> Self {
        Self {
            stage,
            cause: push_cause(&error),
        }
    }
}

// Provider error Display/Debug implementations include payloads and account identifiers.
// Only numeric codes and transport classifications may leave this boundary.
fn push_cause(error: &PushError) -> Value {
    match error {
        PushError::ResourceFailure(failure) => push_cause(&failure.error),
        PushError::DoNotRetry(error) => push_cause(error),
        PushError::BatchError(error) => push_cause(error),
        PushError::APSConnectError(code) => json!({"kind": "apns_connect", "code": code}),
        PushError::APSAckError(code) => json!({"kind": "apns_ack", "code": code}),
        PushError::RegisterFailed(code) => json!({"kind": "ids_registration", "code": code.0}),
        PushError::AuthInvalid(code) => json!({"kind": "ids_auth", "code": code.0}),
        PushError::LookupFailed(code) => json!({"kind": "ids_lookup", "code": code.0}),
        PushError::SendErr(code) => json!({"kind": "send", "code": code}),
        PushError::NoValidTargets => json!({"kind": "no_valid_targets"}),
        PushError::AlbertCertParseError => json!({"kind": "activation_certificate_missing"}),
        PushError::RequestError(error) => json!({
            "kind": "http", "status": error.status().map(|s| s.as_u16()),
            "timeout": error.is_timeout(), "connect": error.is_connect(),
        }),
        PushError::StatusError(status) => json!({"kind": "http", "status": status.as_u16()}),
        PushError::IoError(error) => {
            if let Some(nac_validation::NacError::NacFailed { code, .. }) = error
                .get_ref()
                .and_then(|error| error.downcast_ref::<nac_validation::NacError>())
            {
                json!({"kind": "native_validation", "code": code})
            } else {
                json!({"kind": "io", "io_kind": format!("{:?}", error.kind()), "os_code": error.raw_os_error()})
            }
        }
        PushError::CircleHTTPError(error) => apple_cause(error),
        _ => json!({"kind": "rustpush", "variant": format!("{:?}", std::mem::discriminant(error))}),
    }
}

fn apple_cause(error: &icloud_auth::Error) -> Value {
    match error {
        icloud_auth::Error::AuthSrpWithMessage(code, _) => {
            json!({"kind": "apple_auth", "code": code})
        }
        icloud_auth::Error::Bad2faCode => json!({"kind": "invalid_verification_code"}),
        icloud_auth::Error::ExtraStep(_) => json!({"kind": "account_requires_web_sign_in"}),
        icloud_auth::Error::HardwareKeyError => {
            json!({"kind": "hardware_security_key_required"})
        }
        icloud_auth::Error::ReqwestError(error) => json!({
            "kind": "apple_auth_http", "status": error.status().map(|s| s.as_u16()),
            "timeout": error.is_timeout(), "connect": error.is_connect(),
        }),
        _ => {
            json!({"kind": "apple_auth", "variant": format!("{:?}", std::mem::discriminant(error))})
        }
    }
}

#[cfg(test)]
#[path = "diagnostics_tests.rs"]
mod tests;
