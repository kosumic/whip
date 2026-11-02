use std::collections::HashMap;
use std::future::ready;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64};

use parking_lot::Mutex;
use russh_sftp::protocol::{Attrs, Data, Handle, OpenFlags, Status, StatusCode, Version};
use sha2::{Digest, Sha256};
use tokio::sync::Notify;

use super::*;

const NO_INTERRUPTION: u64 = u64::MAX;

struct Source {
    size: u64,
    modified: AtomicU32,
    interrupt_at: AtomicU64,
    change_on_interrupt: AtomicBool,
    change_at_eof: AtomicBool,
    short: bool,
    has_mtime: bool,
    read_delay: Duration,
    first_reads: Mutex<Vec<u64>>,
}

impl Source {
    fn new(size: u64) -> Arc<Self> {
        Arc::new(Self {
            size,
            modified: AtomicU32::new(1),
            interrupt_at: AtomicU64::new(NO_INTERRUPTION),
            change_on_interrupt: AtomicBool::new(false),
            change_at_eof: AtomicBool::new(false),
            short: false,
            has_mtime: true,
            read_delay: Duration::ZERO,
            first_reads: Mutex::new(Vec::new()),
        })
    }

    async fn connect(self: &Arc<Self>) -> Result<Arc<SftpSession>, TransportError> {
        let (client, server) = tokio::io::duplex(BUFFER_BYTES * 2);
        let disconnected = Arc::new(Notify::new());
        let handler = Server {
            source: self.clone(),
            disconnected: disconnected.clone(),
            first_read: true,
        };
        tokio::spawn(async move {
            tokio::select! {
                () = russh_sftp::server::run(server, handler) => {}
                () = disconnected.notified() => {}
            }
        });
        Ok(Arc::new(SftpSession::new(client).await?))
    }

    fn metadata(&self) -> FileAttributes {
        FileAttributes {
            size: Some(self.size),
            permissions: Some(0o100_644),
            mtime: self
                .has_mtime
                .then(|| self.modified.load(Ordering::Relaxed)),
            atime: self.has_mtime.then_some(0),
            ..Default::default()
        }
    }
}

struct Server {
    source: Arc<Source>,
    disconnected: Arc<Notify>,
    first_read: bool,
}

impl russh_sftp::server::Handler for Server {
    type Error = StatusCode;

    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }

    fn init(
        &mut self,
        _version: u32,
        _extensions: HashMap<String, String>,
    ) -> impl Future<Output = Result<Version, Self::Error>> {
        ready(Ok(Version::new()))
    }

    fn open(
        &mut self,
        id: u32,
        _filename: String,
        _flags: OpenFlags,
        _attrs: FileAttributes,
    ) -> impl Future<Output = Result<Handle, Self::Error>> {
        ready(Ok(Handle {
            id,
            handle: "source".into(),
        }))
    }

    fn stat(&mut self, id: u32, _path: String) -> impl Future<Output = Result<Attrs, Self::Error>> {
        ready(Ok(Attrs {
            id,
            attrs: self.source.metadata(),
        }))
    }

    async fn fstat(&mut self, id: u32, handle: String) -> Result<Attrs, Self::Error> {
        self.stat(id, handle).await
    }

    async fn read(
        &mut self,
        id: u32,
        _handle: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, Self::Error> {
        if !self.source.read_delay.is_zero() {
            tokio::time::sleep(self.source.read_delay).await;
        }
        if self.first_read {
            self.first_read = false;
            self.source.first_reads.lock().push(offset);
        }
        if offset >= self.source.interrupt_at.load(Ordering::Relaxed)
            && self
                .source
                .interrupt_at
                .swap(NO_INTERRUPTION, Ordering::Relaxed)
                != NO_INTERRUPTION
        {
            if self.source.change_on_interrupt.load(Ordering::Relaxed) {
                self.source.modified.fetch_add(1, Ordering::Relaxed);
            }
            // Tear down the transport while a real SFTP read is outstanding.
            self.disconnected.notify_one();
            return std::future::pending().await;
        }
        let actual_size = if self.source.short {
            self.source.size / 2
        } else {
            self.source.size
        };
        if offset >= actual_size {
            if self.source.change_at_eof.swap(false, Ordering::Relaxed) {
                self.source.modified.fetch_add(1, Ordering::Relaxed);
            }
            return Err(StatusCode::Eof);
        }
        let count = u64::from(len).min(actual_size - offset);
        let generation = u64::from(self.source.modified.load(Ordering::Relaxed));
        Ok(Data {
            id,
            data: (offset..offset + count)
                .map(|position| ((position + generation) % 251) as u8)
                .collect(),
        })
    }

    fn close(
        &mut self,
        id: u32,
        _handle: String,
    ) -> impl Future<Output = Result<Status, Self::Error>> {
        ready(Ok(Status {
            id,
            status_code: StatusCode::Ok,
            error_message: String::new(),
            language_tag: String::new(),
        }))
    }
}

async fn assert_payload(path: &std::path::Path, size: u64, modified: u64) {
    assert_eq!(fs::metadata(path).await.unwrap().len(), size);
    let mut file = fs::File::open(path).await.unwrap();
    let mut actual = Sha256::new();
    let mut expected = Sha256::new();
    let mut buffer = vec![0; BUFFER_BYTES];
    let mut offset = 0;
    loop {
        let count = file.read(&mut buffer).await.unwrap();
        if count == 0 {
            break;
        }
        actual.update(&buffer[..count]);
        for (index, byte) in buffer[..count].iter_mut().enumerate() {
            *byte = ((offset + index as u64 + modified) % 251) as u8;
        }
        expected.update(&buffer[..count]);
        offset += count as u64;
    }
    assert_eq!(actual.finalize(), expected.finalize());
}

#[test]
fn normal_empty_100_and_500_mb_downloads_have_verified_size_and_contents() {
    crate::runtime().unwrap().block_on(async {
        for size in [0, 100_000_000, 500_000_000] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("download");
            let source = Source::new(size);
            let (_sender, cancel) = watch::channel(false);
            let mut final_progress = (0, None);
            download(
                path.to_str().unwrap().into(),
                "/private-source".into(),
                "large",
                cancel,
                |bytes, total| final_progress = (bytes, total),
                || source.connect(),
            )
            .await
            .unwrap();
            assert_eq!(final_progress, (size, Some(size)));
            assert_eq!(*source.first_reads.lock(), vec![0]);
            assert_payload(&path, size, 1).await;
            assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
        }
    });
}

#[test]
fn interrupted_download_resumes_only_when_the_source_is_unchanged() {
    crate::runtime().unwrap().block_on(async {
        for (changed, has_mtime) in [(false, true), (true, true), (false, false)] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("download");
            let mut source = Source::new(2_000_000);
            Arc::get_mut(&mut source).unwrap().has_mtime = has_mtime;
            source.interrupt_at.store(512 * 1024, Ordering::Relaxed);
            source.change_on_interrupt.store(changed, Ordering::Relaxed);
            let (_sender, cancel) = watch::channel(false);
            download(
                path.to_str().unwrap().into(),
                "/source".into(),
                "resume",
                cancel,
                |_, _| {},
                || source.connect(),
            )
            .await
            .unwrap();
            let reads = source.first_reads.lock().clone();
            assert_eq!(reads.len(), 2);
            if changed || !has_mtime {
                assert_eq!(reads[1], 0);
            } else {
                assert!(reads[1] > 0);
            }
            assert_payload(&path, source.size, if changed { 2 } else { 1 }).await;
        }
    });
}

#[test]
fn slow_downloads_report_progress_before_completion() {
    crate::runtime().unwrap().block_on(async {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("download");
        let mut source = Source::new(128 * 1024);
        Arc::get_mut(&mut source).unwrap().read_delay = Duration::from_millis(200);
        let (_sender, cancel) = watch::channel(false);
        let mut updates = Vec::new();
        download(
            path.to_str().unwrap().into(),
            "/source".into(),
            "slow",
            cancel,
            |bytes, _| updates.push(bytes),
            || source.connect(),
        )
        .await
        .unwrap();
        assert!(
            updates
                .iter()
                .any(|bytes| *bytes > 0 && *bytes < source.size)
        );
        assert_payload(&path, source.size, 1).await;
    });
}

#[test]
fn source_modified_during_transfer_restarts_before_publication() {
    crate::runtime().unwrap().block_on(async {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("download");
        let source = Source::new(1_000_000);
        source.change_at_eof.store(true, Ordering::Relaxed);
        let (_sender, cancel) = watch::channel(false);
        download(
            path.to_str().unwrap().into(),
            "/source".into(),
            "changed",
            cancel,
            |_, _| {},
            || source.connect(),
        )
        .await
        .unwrap();
        assert_eq!(*source.first_reads.lock(), vec![0, 0]);
        assert_payload(&path, source.size, 2).await;
    });
}

#[test]
fn premature_eof_exhausts_bounded_retries_without_replacing_the_destination() {
    crate::runtime().unwrap().block_on(async {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("download");
        fs::write(&path, b"existing file").await.unwrap();
        let mut source = Source::new(1_000_000);
        Arc::get_mut(&mut source).unwrap().short = true;
        let (_sender, cancel) = watch::channel(false);
        let error = download(
            path.to_str().unwrap().into(),
            "/source".into(),
            "short",
            cancel,
            |_, _| {},
            || source.connect(),
        )
        .await
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("advertised size after 4 attempts")
        );
        assert_eq!(source.first_reads.lock().len(), MAX_ATTEMPTS as usize);
        assert_eq!(fs::read(&path).await.unwrap(), b"existing file");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    });
}

#[test]
fn cancel_and_task_abort_remove_partials_without_publishing() {
    crate::runtime().unwrap().block_on(async {
        for abort in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("download");
            let source = Source::new(10_000_000);
            let (sender, cancel) = watch::channel(false);
            let progressed = Arc::new(Notify::new());
            let gate = progressed.clone();
            let output = path.to_str().unwrap().to_owned();
            let task = tokio::spawn(async move {
                download(
                    output,
                    "/source".into(),
                    "cancel",
                    cancel,
                    move |bytes, _| {
                        if bytes > 0 {
                            gate.notify_one();
                            if !abort {
                                sender.send_replace(true);
                            }
                        }
                    },
                    || source.connect(),
                )
                .await
            });
            tokio::time::timeout(Duration::from_secs(5), progressed.notified())
                .await
                .unwrap();
            if abort {
                task.abort();
                assert!(task.await.unwrap_err().is_cancelled());
            } else {
                assert!(
                    task.await
                        .unwrap()
                        .unwrap_err()
                        .to_string()
                        .contains("cancelled")
                );
            }
            assert!(!path.exists());
            assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
        }
    });
}

#[test]
#[cfg(target_os = "linux")]
fn local_no_space_is_terminal_and_cannot_be_reported_as_success() {
    crate::runtime().unwrap().block_on(async {
        let source = Source::new(1_000_000);
        let sftp = source.connect().await.unwrap();
        let file = fs::OpenOptions::new()
            .write(true)
            .open("/dev/full")
            .await
            .unwrap();
        let identity = Identity::read(&source.metadata()).unwrap();
        // /dev/full rejects writes with ENOSPC while accepting seeks.
        let mut download = Download {
            file,
            identity: Some(identity),
            copied: 0,
        };
        let (_sender, mut cancel) = watch::channel(false);
        let error = download
            .attempt(&sftp, "/source", &mut cancel, &mut |_, _| {})
            .await
            .unwrap_err();
        assert!(
            matches!(error, Failure::Stop(error) if error.to_string().contains("storage is full"))
        );
    });
}
