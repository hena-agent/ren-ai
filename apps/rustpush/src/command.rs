use crate::diagnostics::Failure;

pub const SERVICE_HANDLE: &str = "mailto:hi@renai.im";

#[derive(Debug, PartialEq)]
pub enum Command {
    Preflight,
    Login,
    Rpc(String),
}

pub fn parse(args: &[String]) -> Result<Command, Failure> {
    match args {
        [command] if command == "preflight" => Ok(Command::Preflight),
        [command] if command == "login" => Ok(Command::Login),
        [command, handle] if command == "rpc" && handle == SERVICE_HANDLE => {
            Ok(Command::Rpc(handle.clone()))
        }
        _ => Err(Failure::new("arguments", "invalid_command")),
    }
}

pub fn require_handle(handle: &str, registered: &[String]) -> Result<(), Failure> {
    if registered.iter().any(|registered| registered == handle) {
        Ok(())
    } else {
        Err(Failure::new("identity", "service_handle_not_registered"))
    }
}

#[cfg(test)]
#[path = "command_tests.rs"]
mod tests;
