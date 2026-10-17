use std::io;

/// Runs a filesystem operation. Tests can fail an operation before it changes disk state.
pub trait Io: Send + Sync {
    fn check(&self, stage: &'static str) -> io::Result<()>;
}

impl dyn Io {
    pub fn run<T>(
        &self,
        stage: &'static str,
        operation: impl FnOnce() -> io::Result<T>,
    ) -> io::Result<T> {
        self.check(stage)?;
        operation()
    }
}

pub struct System;

impl Io for System {
    fn check(&self, _stage: &'static str) -> io::Result<()> {
        Ok(())
    }
}
