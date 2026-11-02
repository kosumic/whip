use super::*;
use crate::ssh::{ReverseForwardFixture, SshSession};
use parking_lot::Mutex;
use sha2::{Digest, Sha256};
type TestResult = Result<(), Box<dyn std::error::Error>>;
struct TestSource {
    ssh: Arc<SshSession>,
    events: Mutex<Vec<DownloadDiagnostic>>,
    stop: Mutex<Option<Failure>>,
}
impl TestSource {
    fn new(ssh: Arc<SshSession>) -> Self {
        Self {
            ssh,
            events: Mutex::new(vec![]),
            stop: Mutex::new(None),
        }
    }
}
#[async_trait::async_trait]
impl Source for TestSource {
    fn check(&self) -> Result<(), Failure> {
        self.stop.lock().map_or(Ok(()), Err)
    }
    async fn connect(
        &self,
        renew: bool,
        _: &mut watch::Receiver<bool>,
    ) -> Result<Connection, Failure> {
        Ok(Connection {
            sftp: self.ssh.download_sftp(renew).await?,
            generation: 1,
        })
    }
    fn diagnostic(&self, event: DownloadDiagnostic) {
        self.events.lock().push(event);
    }
}
async fn make_file(path: &std::path::Path, size: u64) -> std::io::Result<Vec<u8>> {
    let mut file = fs::File::create(path).await?;
    let mut hash = Sha256::new();
    let mut bytes = 0;
    while bytes < size {
        let length = usize::try_from((size - bytes).min(BUFFER_BYTES as u64)).unwrap();
        let mut block = vec![0xa5; length];
        if length >= 8 {
            block[..8].copy_from_slice(&bytes.to_le_bytes());
        }
        hash.update(&block);
        file.write_all(&block).await?;
        bytes += length as u64;
    }
    file.sync_all().await?;
    Ok(hash.finalize().to_vec())
}
async fn hash(path: &std::path::Path) -> std::io::Result<Vec<u8>> {
    let mut file = fs::File::open(path).await?;
    let mut hash = Sha256::new();
    let mut bytes = vec![0; BUFFER_BYTES];
    loop {
        let count = file.read(&mut bytes).await?;
        if count == 0 {
            break;
        }
        hash.update(&bytes[..count]);
    }
    Ok(hash.finalize().to_vec())
}
async fn cleaned(parent: &std::path::Path) -> TestResult {
    for _ in 0..100 {
        let mut entries = fs::read_dir(parent).await?;
        let mut partial = false;
        while let Some(entry) = entries.next_entry().await? {
            partial |= entry
                .file_name()
                .to_string_lossy()
                .contains(".whip-download-");
        }
        if !partial {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    Err("private partial file was not cleaned".into())
}
#[test]
fn interrupted_sftp_reads_resume_at_retained_offset_and_verify_all_bytes() -> TestResult {
    crate::runtime()?.block_on(async {
        let fixture = ReverseForwardFixture::new(true, Duration::ZERO).await?;
        let directory = tempfile::tempdir()?;
        let remote = directory.path().join("remote");
        let local = directory.path().join("download");
        let expected = make_file(&remote, 4 * 1024 * 1024).await?;
        fixture.fail_reads_after(1024 * 1024, 1);
        let source = TestSource::new(fixture.ssh.clone());
        let (_cancel, cancel) = watch::channel(false);
        download(
            &source,
            remote.to_str().unwrap(),
            local.to_str().unwrap(),
            cancel,
            |_, _| {},
        )
        .await?;
        assert_eq!(hash(&local).await?, expected);
        assert_eq!(
            fixture
                .read_offsets()
                .iter()
                .filter(|&&offset| offset == 0)
                .count(),
            1,
            "retry must not silently start the remote read at zero"
        );
        assert!(
            source
                .events
                .lock()
                .iter()
                .any(|event| event.attempt == 2 && event.bytes_transferred >= 1024 * 1024)
        );
        assert!(
            source
                .events
                .lock()
                .iter()
                .any(|event| event.error_category == Some(DownloadErrorCategory::RemoteRead))
        );
        cleaned(directory.path()).await
    })
}
#[test]
fn premature_eof_cannot_publish_a_short_file_and_is_recoverable() -> TestResult {
    crate::runtime()?.block_on(async {
        let fixture = ReverseForwardFixture::new(true, Duration::ZERO).await?;
        let directory = tempfile::tempdir()?;
        let remote = directory.path().join("remote");
        let local = directory.path().join("download");
        let expected = make_file(&remote, 2 * 1024 * 1024).await?;
        fixture.short_read_once_after(1024 * 1024);
        let source = TestSource::new(fixture.ssh.clone());
        let (_cancel, cancel) = watch::channel(false);
        download(
            &source,
            remote.to_str().unwrap(),
            local.to_str().unwrap(),
            cancel,
            |_, _| {},
        )
        .await?;
        assert_eq!(hash(&local).await?, expected);
        assert!(
            source
                .events
                .lock()
                .iter()
                .any(|event| event.error_category == Some(DownloadErrorCategory::Incomplete))
        );
        assert_eq!(fs::metadata(local).await?.len(), 2 * 1024 * 1024);
        Ok(())
    })
}
#[test]
fn changed_source_discards_the_old_prefix_and_restarts_cleanly() -> TestResult {
    crate::runtime()?.block_on(async {
        for changed_size in [false,true] {
            let fixture=ReverseForwardFixture::new(true,Duration::ZERO).await?;
            let directory=tempfile::tempdir()?; let remote=directory.path().join("remote"); let local=directory.path().join("download");
            make_file(&remote,2*1024*1024).await?;
            let replacement=vec![0x7b;if changed_size {3*1024*1024} else {2*1024*1024}];
            fixture.replace_source_after(1024*1024,replacement.clone());
            let source=TestSource::new(fixture.ssh.clone()); let (_cancel,cancel)=watch::channel(false);
            download(&source,remote.to_str().unwrap(),local.to_str().unwrap(),cancel,|_,_|{}).await?;
            assert_eq!(fs::read(&local).await?,replacement);
            assert!(source.events.lock().iter().any(|event|event.error_category==Some(DownloadErrorCategory::SourceChanged)));
            assert!(fixture.read_offsets().iter().filter(|&&offset|offset==0).count()>=2);
        }
        Ok(())
    })
}
#[test]
fn permanent_read_failure_is_bounded_and_preserves_an_existing_destination() -> TestResult {
    crate::runtime()?.block_on(async {
        let fixture = ReverseForwardFixture::new(true, Duration::ZERO).await?;
        let directory = tempfile::tempdir()?;
        let remote = directory.path().join("remote");
        let local = directory.path().join("download");
        make_file(&remote, 2 * 1024 * 1024).await?;
        fs::write(&local, b"existing destination").await?;
        fixture.fail_reads_after(1024 * 1024, 10);
        let source = TestSource::new(fixture.ssh.clone());
        let (_cancel, cancel) = watch::channel(false);
        let failure = download(
            &source,
            remote.to_str().unwrap(),
            local.to_str().unwrap(),
            cancel,
            |_, _| {},
        )
        .await
        .unwrap_err();
        assert_eq!(failure.category, DownloadErrorCategory::RemoteRead);
        assert_eq!(
            source.events.lock().iter().map(|event| event.attempt).max(),
            Some(MAX_ATTEMPTS)
        );
        assert_eq!(fs::read(&local).await?, b"existing destination");
        assert!(
            !source
                .events
                .lock()
                .iter()
                .any(|event| event.phase == DownloadPhase::Completed)
        );
        cleaned(directory.path()).await
    })
}
#[test]
fn cancel_and_local_storage_failures_never_publish_or_retry_unsafe_writes() -> TestResult {
    crate::runtime()?.block_on(async {
        for category in [
            DownloadErrorCategory::Cancelled,
            DownloadErrorCategory::NoSpace,
            DownloadErrorCategory::LocalWrite,
        ] {
            let fixture = ReverseForwardFixture::new(true, Duration::ZERO).await?;
            let directory = tempfile::tempdir()?;
            let remote = directory.path().join("remote");
            let local = directory.path().join("download");
            make_file(&remote, 2 * 1024 * 1024).await?;
            fs::write(&local, b"existing destination").await?;
            let source = TestSource::new(fixture.ssh.clone());
            let (_cancel, cancel) = watch::channel(false);
            let failure = download(
                &source,
                remote.to_str().unwrap(),
                local.to_str().unwrap(),
                cancel,
                |bytes, _| {
                    if bytes > 0 {
                        *source.stop.lock() =
                            Some(Failure::new(DownloadPhase::LocalWrite, category));
                    }
                },
            )
            .await
            .unwrap_err();
            assert_eq!(failure.category, category);
            assert_eq!(fs::read(&local).await?, b"existing destination");
            assert_eq!(
                source.events.lock().iter().map(|event| event.attempt).max(),
                Some(1)
            );
            cleaned(directory.path()).await?;
        }
        let full = Failure::local(
            DownloadPhase::LocalWrite,
            &std::io::Error::from(std::io::ErrorKind::StorageFull),
        );
        assert_eq!(full.category, DownloadErrorCategory::NoSpace);
        assert!(!full.retryable());
        Ok(())
    })
}
#[test]
fn cancellation_of_a_blocked_read_is_prompt_and_does_not_publish() -> TestResult {
    crate::runtime()?.block_on(async {
        let fixture = ReverseForwardFixture::new(true, Duration::ZERO).await?;
        let directory = tempfile::tempdir()?;
        let remote = directory.path().join("remote");
        let local = directory.path().join("download");
        make_file(&remote, 2 * 1024 * 1024).await?;
        let gate = fixture.pause_read_after(1024 * 1024);
        let source = TestSource::new(fixture.ssh.clone());
        let (send, cancel) = watch::channel(false);
        let transfer = download(
            &source,
            remote.to_str().unwrap(),
            local.to_str().unwrap(),
            cancel,
            |_, _| {},
        );
        let cancel_blocked = async {
            while !fixture
                .read_offsets()
                .iter()
                .any(|&offset| offset >= 1024 * 1024)
            {
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
            send.send_replace(true);
        };
        let (result, ()) = tokio::join!(
            tokio::time::timeout(Duration::from_secs(3), transfer),
            cancel_blocked
        );
        assert_eq!(
            result?.unwrap_err().category,
            DownloadErrorCategory::Cancelled
        );
        assert!(!local.exists());
        gate.add_permits(1);
        cleaned(directory.path()).await?;
        Ok(())
    })
}
#[test]
#[ignore = "large real-SFTP regression: writes and verifies 100 MiB and 500 MiB"]
fn normal_100_and_500_mib_downloads_have_no_size_ceiling() -> TestResult {
    crate::runtime()?.block_on(async {
        for megabytes in [100_u64, 500] {
            let fixture = ReverseForwardFixture::new(true, Duration::ZERO).await?;
            let directory = tempfile::tempdir()?;
            let remote = directory.path().join("remote");
            let local = directory.path().join("download");
            let size = megabytes * 1024 * 1024;
            let expected = make_file(&remote, size).await?;
            let source = TestSource::new(fixture.ssh.clone());
            let (_cancel, cancel) = watch::channel(false);
            download(
                &source,
                remote.to_str().unwrap(),
                local.to_str().unwrap(),
                cancel,
                |_, _| {},
            )
            .await?;
            assert_eq!(fs::metadata(&local).await?.len(), size);
            assert_eq!(hash(&local).await?, expected);
            assert_eq!(
                source.events.lock().last().unwrap().phase,
                DownloadPhase::Completed
            );
        }
        Ok(())
    })
}

#[test]
fn directory_download_preserves_the_server_failure_reason() -> TestResult {
    crate::runtime()?.block_on(async {
        let fixture = ReverseForwardFixture::new(true, Duration::ZERO).await?;
        let directory = tempfile::tempdir()?;
        let remote = directory.path().join("remote-directory");
        let local = directory.path().join("local-directory");
        fs::create_dir(&remote).await?;
        let source = TestSource::new(fixture.ssh.clone());
        let (_sender, cancel) = watch::channel(false);
        let error = download_entry(
            &source,
            remote.to_str().unwrap(),
            local.to_str().unwrap(),
            cancel,
            Arc::new(|_, _| {}),
        )
        .await
        .unwrap_err();
        // This server deliberately lacks REALPATH. Surface its capability failure
        // instead of turning directory failures into interrupted file reads.
        assert!(
            error.to_string().to_lowercase().contains("unsupported"),
            "unexpected directory download failure: {error}"
        );
        assert!(!local.exists());
        Ok(())
    })
}
