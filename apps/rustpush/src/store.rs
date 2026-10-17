use crate::diagnostics::Failure;
use serde::{de::DeserializeOwned, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

pub struct Store {
    pub path: PathBuf,
    _lock: File,
}

impl Store {
    pub fn open(path: PathBuf) -> Result<Self, Failure> {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&path)
            .map_err(|e| Failure::io("state_directory", e))?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
            .map_err(|e| Failure::io("state_permissions", e))?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .mode(0o600)
            .open(path.join("lock"))
            .map_err(|e| Failure::io("state_lock", e))?;
        lock.try_lock()
            .map_err(|_| Failure::new("state_lock", "another_process_is_using_state"))?;
        Ok(Self { path, _lock: lock })
    }

    pub fn load<T: DeserializeOwned>(&self, name: &str) -> Result<Option<T>, Failure> {
        let bytes = match fs::read(self.path.join(name)) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(Failure::io("state_read", error)),
        };
        plist::from_bytes(&bytes)
            .map(Some)
            .map_err(|_| Failure::new("state_decode", "invalid_private_state"))
    }

    pub fn save<T: Serialize>(&self, name: &str, value: &T) -> Result<(), Failure> {
        let mut bytes = Vec::new();
        plist::to_writer_binary(&mut bytes, value)
            .map_err(|_| Failure::new("state_encode", "private_state_encode_failed"))?;
        atomic_write(&self.path.join(name), &bytes)
            .map_err(|error| Failure::io("state_write", error))
    }

    pub fn pending(&self) -> Result<std::collections::VecDeque<String>, Failure> {
        let entries = fs::read_dir(&self.path).map_err(|e| Failure::io("inbox_list", e))?;
        let mut names = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|e| Failure::io("inbox_list", e))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("inbox-") && name.ends_with(".plist") {
                names.push(name);
            }
        }
        names.sort();
        Ok(names.into())
    }

    pub fn remove(&self, name: &str) -> Result<(), Failure> {
        fs::remove_file(self.path.join(name)).map_err(|e| Failure::io("inbox_remove", e))?;
        File::open(&self.path)
            .and_then(|dir| dir.sync_all())
            .map_err(|e| Failure::io("inbox_sync", e))
    }

    /// The private location of a downloaded attachment.
    pub fn attachment(&self, name: &str) -> Result<PathBuf, Failure> {
        let directory = self.path.join("attachments");
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&directory)
            .map_err(|e| Failure::io("attachment_directory", e))?;
        Ok(directory.join(name))
    }

    pub fn partial(&self, path: &Path) -> Result<File, Failure> {
        OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path.with_extension("partial"))
            .map_err(|e| Failure::io("attachment_create", e))
    }

    /// Publishes a completely written, nonempty download under its final name.
    pub fn commit(&self, file: File, path: &Path) -> Result<(), Failure> {
        let partial = path.with_extension("partial");
        let result = (|| {
            file.sync_all()
                .map_err(|e| Failure::io("attachment_sync", e))?;
            let size = file
                .metadata()
                .map_err(|e| Failure::io("attachment_size", e))?
                .len();
            if size == 0 {
                return Err(Failure::new("attachment_download", "empty_attachment"));
            }
            fs::rename(&partial, path).map_err(|e| Failure::io("attachment_save", e))?;
            File::open(path.parent().expect("attachments have a parent"))
                .and_then(|directory| directory.sync_all())
                .map_err(|e| Failure::io("attachment_directory_sync", e))
        })();
        if result.is_err() {
            let _ = fs::remove_file(&partial);
        }
        result
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        File::open(path.parent().expect("state files have a parent"))?.sync_all()
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
