use crate::{diagnostics::Failure, local_config::LocalMacOSConfig, session_state, store::Store};
use keystore::{
    init_keystore,
    software::{NoEncryptor, SoftwareKeystore},
};
use rustpush::{
    authenticate_apple, default_provider, login_apple_delegates, register, APSConnection,
    APSConnectionResource, AppleAccount, IDSNGMIdentity, IDSUser, IMClient, LoginDelegate,
    OSConfig, PushError, MADRID_SERVICE,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    sync::{Arc, Mutex, RwLock},
    time::Duration,
};

#[derive(Clone, Serialize, Deserialize)]
struct Identity {
    users: Vec<IDSUser>,
    identity: IDSNGMIdentity,
}

pub struct Session {
    pub connection: APSConnection,
    pub inbox: tokio::sync::mpsc::UnboundedReceiver<String>,
    pub pending: std::collections::VecDeque<String>,
    pub client: IMClient,
    pub store: Arc<Store>,
}

// Upstream persistence callbacks cannot return an error. Stop immediately if keys cannot
// be persisted, rather than continue with a session that will be unrecoverable on restart.
fn save_or_exit<T: Serialize>(store: &Store, name: &str, value: &T, request_id: &str) {
    let started = std::time::Instant::now();
    if let Err(error) = store.save(name, value) {
        eprintln!(
            "{}",
            serde_json::json!({
            "level": "error", "operation": "persist_state", "request_id": request_id,
            "stage": error.stage, "cause": error.cause, "outcome": "failure",
            "duration_ms": started.elapsed().as_millis(),
            })
        );
        std::process::exit(1);
    }
}

pub async fn connect(
    store: Arc<Store>,
    request_id: &str,
) -> Result<
    (
        APSConnection,
        Arc<dyn OSConfig>,
        tokio::sync::mpsc::UnboundedReceiver<String>,
    ),
    Failure,
> {
    let state = store.load("keys.plist")?.unwrap_or_default();
    let key_store = store.clone();
    let key_request_id = request_id.to_owned();
    init_keystore(SoftwareKeystore {
        state: RwLock::new(state),
        update_state: Box::new(move |keys| {
            save_or_exit(&key_store, "keys.plist", keys, &key_request_id)
        }),
        encryptor: NoEncryptor,
    });
    let config: Arc<dyn OSConfig> = Arc::new(
        LocalMacOSConfig::new()
            .map_err(|_| Failure::new("hardware", "hardware_info_read_failed"))?
            .into_macos_config(),
    );
    let (notify, inbox) = tokio::sync::mpsc::unbounded_channel();
    let incoming_store = store.clone();
    let incoming_request_id = request_id.to_owned();
    let (connection, error) = tokio::time::timeout(
        Duration::from_secs(60),
        APSConnectionResource::new(
            config.clone(),
            store.load("push.plist")?,
            Box::new(move |notification| {
                if let Err(error) =
                    session_state::notification(&incoming_store, notification, &notify)
                {
                    crate::rpc::report(
                        "error",
                        "persist_notification",
                        &incoming_request_id,
                        &error,
                    );
                    std::process::exit(1);
                }
            }),
        ),
    )
    .await
    .map_err(|_| Failure::new("apns", "timeout"))?;
    if let Some(error) = error {
        return Err(Failure::push("apns", error));
    }
    store.save("push.plist", &*connection.state.read().await)?;
    Ok((connection, config, inbox))
}

impl Session {
    pub async fn open(store: Arc<Store>, login: bool, request_id: &str) -> Result<Self, Failure> {
        let existing: Option<Identity> = session_state::restore(&store, login)?;
        let (connection, config, inbox) = connect(store.clone(), request_id).await?;
        let mut state = session_state::initialize(&store, existing, async {
            let user = sign_in(&connection, config.as_ref(), &store).await?;
            let identity = IDSNGMIdentity::new().map_err(|e| Failure::push("identity", e))?;
            Ok(Identity {
                users: vec![user],
                identity,
            })
        })
        .await?;
        if state.users.iter().any(|user| user.registration.is_empty()) {
            register(
                config.as_ref(),
                &*connection.state.read().await,
                &[&MADRID_SERVICE],
                &mut state.users,
                &state.identity,
            )
            .await
            .map_err(|e| Failure::push("register", e))?;
            store.save("identity.plist", &state)?;
        }
        let saved = Arc::new(Mutex::new(state.clone()));
        let updated_store = store.clone();
        let updated_request_id = request_id.to_owned();
        let client = IMClient::new(
            connection.clone(),
            state.users,
            state.identity,
            &[&MADRID_SERVICE],
            store.path.join("id-cache.plist"),
            config,
            Box::new(move |users| {
                let mut state = saved.lock().expect("identity state mutex poisoned");
                state.users = users;
                save_or_exit(
                    &updated_store,
                    "identity.plist",
                    &*state,
                    &updated_request_id,
                );
            }),
        )
        .await;
        let pending = store.pending()?;
        Ok(Self {
            connection,
            inbox,
            pending,
            client,
            store,
        })
    }
}

async fn sign_in(
    connection: &APSConnection,
    config: &dyn OSConfig,
    store: &Store,
) -> Result<IDSUser, Failure> {
    eprintln!(
        "Sign in to the Apple Account that owns the service handle. Credentials are not saved."
    );
    let username = rpassword::prompt_password("Apple Account (hidden): ")
        .map_err(|e| Failure::io("login_input", e))?;
    let password =
        rpassword::prompt_password("Password: ").map_err(|e| Failure::io("login_input", e))?;
    let password_hash = Sha256::digest(password.as_bytes()).to_vec();
    drop(password);
    let info = config.get_gsa_config(&*connection.state.read().await, false);
    let anisette = default_provider(info.clone(), store.path.join("anisette"));
    let input_error = Mutex::new(None);
    let account = AppleAccount::login(
        || (username.trim().to_owned(), password_hash.clone()),
        || match rpassword::prompt_password("Apple verification code: ") {
            Ok(code) => code.trim().to_owned(),
            Err(error) => {
                *input_error.lock().expect("input mutex poisoned") = Some(error);
                String::new()
            }
        },
        info,
        anisette,
    )
    .await;
    if let Some(error) = input_error.into_inner().expect("input mutex poisoned") {
        return Err(Failure::io("login_input", error));
    }
    let account =
        account.map_err(|e| Failure::push("apple_login", PushError::CircleHTTPError(e)))?;
    let delegates = login_apple_delegates(&account, None, config, &[LoginDelegate::IDS])
        .await
        .map_err(|e| Failure::push("ids_login", e))?;
    let ids = delegates
        .ids
        .ok_or_else(|| Failure::new("ids_login", "missing_ids_delegate"))?;
    authenticate_apple(ids, config)
        .await
        .map_err(|e| Failure::push("ids_authenticate", e))
}
