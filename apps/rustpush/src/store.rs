use crate::diagnostics::Failure;
use crate::io::{Io, System};
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
    io: Box<dyn Io>,
}

impl Store {
    pub fn open(path: PathBuf) -> Result<Self, Failure> {
        Self::using(path, Box::new(System))
    }
    fn using(path: PathBuf, io: Box<dyn Io>) -> Result<Self, Failure> {
        Failure::io_result(
            "state_directory",
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(&path),
        )?;
        Failure::io_result(
            "state_permissions",
            io.run("state_permissions", || {
                fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
            }),
        )?;
        let lock = Failure::io_result(
            "state_lock",
            OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .mode(0o600)
                .open(path.join("lock")),
        )?;
        lock.try_lock()
            .map_err(|_| Failure::new("state_lock", "another_process_is_using_state"))?;
        Ok(Self {
            path,
            _lock: lock,
            io,
        })
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
        Failure::io_result(
            "state_write",
            atomic_write(&*self.io, &self.path.join(name), &bytes),
        )
    }

    pub fn pending(&self) -> Result<std::collections::VecDeque<String>, Failure> {
        let entries = Failure::io_result("inbox_list", fs::read_dir(&self.path))?;
        let mut names = Vec::new();
        for entry in entries {
            let entry = Failure::io_result("inbox_list", self.io.run("inbox_entry", || entry))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("inbox-") && name.ends_with(".plist") {
                names.push(name);
            }
        }
        names.sort();
        Ok(names.into())
    }

    pub fn remove(&self, name: &str) -> Result<(), Failure> {
        Failure::io_result("inbox_remove", fs::remove_file(self.path.join(name)))?;
        Failure::io_result(
            "inbox_sync",
            File::open(&self.path).and_then(|dir| dir.sync_all()),
        )
    }

    /// The private location of a downloaded attachment.
    pub fn attachment(&self, name: &str) -> Result<PathBuf, Failure> {
        let directory = self.path.join("attachments");
        Failure::io_result(
            "attachment_directory",
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(&directory),
        )?;
        Ok(directory.join(name))
    }

    pub fn partial(&self, path: &Path) -> Result<File, Failure> {
        Failure::io_result(
            "attachment_create",
            OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(path.with_extension("partial")),
        )
    }

    /// Publishes a completely written, nonempty download under its final name.
    pub fn commit(&self, file: File, path: &Path) -> Result<(), Failure> {
        let partial = path.with_extension("partial");
        let result = (|| {
            Failure::io_result(
                "attachment_sync",
                self.io.run("attachment_sync", || file.sync_all()),
            )?;
            let size = Failure::io_result(
                "attachment_size",
                self.io.run("attachment_size", || file.metadata()),
            )?
            .len();
            if size == 0 {
                return Err(Failure::new("attachment_download", "empty_attachment"));
            }
            Failure::io_result("attachment_save", fs::rename(&partial, path))?;
            Failure::io_result(
                "attachment_directory_sync",
                File::open(path.parent().expect("attachments have a parent"))
                    .and_then(|directory| directory.sync_all()),
            )
        })();
        if result.is_err() {
            let _ = fs::remove_file(&partial);
        }
        result
    }
}

fn atomic_write(io: &(dyn Io + 'static), path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = io.run("state_create", || {
            OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(&temporary)
        })?;
        io.run("state_write", || file.write_all(bytes))?;
        io.run("state_sync", || file.sync_all())?;
        fs::rename(&temporary, path)?;
        io.run("state_parent", || {
            File::open(path.parent().expect("state files have a parent"))
        })?
        .sync_all()
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
#[path = "store_tests.rs"]
pub(crate) mod tests;
