use super::{params, recipient, Failure, Native};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Availability {
    to: String,
}

pub(super) async fn call<N: Native>(
    native: &N,
    from: &str,
    input: Value,
) -> Result<Value, Failure> {
    let p: Availability = params(input)?;
    recipient(&p.to, from)?;
    Ok(json!({"available": native.availability(from, &p.to).await?}))
}
