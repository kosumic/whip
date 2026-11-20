use super::*;
use std::net::TcpListener;

const TEST_ARTIFACT: Artifact = Artifact {
    name: "test",
    bytes: 3,
    sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
};

fn server(
    response: &'static [u8],
    range: Option<&'static str>,
) -> (String, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/test", listener.local_addr().unwrap());
    let worker = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut request = Vec::new();
        loop {
            let mut byte = [0];
            socket.read_exact(&mut byte).unwrap();
            request.push(byte[0]);
            if request.ends_with(b"\r\n\r\n") {
                break;
            }
        }
        let request = String::from_utf8(request).unwrap().to_lowercase();
        match range {
            Some(value) => assert!(request.contains(&format!("range: {value}"))),
            None => assert!(!request.contains("range:")),
        }
        socket.write_all(response).unwrap();
    });
    (url, worker)
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

#[test]
fn range_resume_and_ignored_range_both_produce_verified_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test");
    let client = Client::new();
    let cancel = AtomicBool::new(false);
    for response in [
        b"HTTP/1.1 206 Partial Content\r\nContent-Length: 2\r\nContent-Range: bytes 1-2/3\r\nConnection: close\r\n\r\nbc".as_slice(),
        b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc".as_slice(),
    ] {
        fs::write(&path, b"a").unwrap();
        let (url, worker) = server(response, Some("bytes=1-"));
        let mut progress = Vec::new();
        // The production progress callback is Fn, just as in Whip.
        let values = std::cell::RefCell::new(&mut progress);
        runtime().block_on(fetch(&client, &url, &path, TEST_ARTIFACT, &cancel, |n| values.borrow_mut().push(n))).unwrap();
        worker.join().unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"abc");
        assert_eq!(progress.last(), Some(&3));
    }
}

#[test]
fn wrong_range_keeps_the_previous_partial_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test");
    fs::write(&path, b"a").unwrap();
    let (url, worker) = server(b"HTTP/1.1 206 Partial Content\r\nContent-Length: 2\r\nContent-Range: bytes 0-1/3\r\nConnection: close\r\n\r\nbc", Some("bytes=1-"));
    assert!(
        runtime()
            .block_on(fetch(
                &Client::new(),
                &url,
                &path,
                TEST_ARTIFACT,
                &AtomicBool::new(false),
                |_| {}
            ))
            .is_err()
    );
    worker.join().unwrap();
    assert_eq!(fs::read(path).unwrap(), b"a");
}

#[test]
fn interrupted_response_resumes_but_complete_corruption_restarts() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test");
    let client = Client::new();
    let cancel = AtomicBool::new(false);
    // Valid short HTTP body, shorter than the pinned artifact.
    let (url, worker) = server(
        b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\nConnection: close\r\n\r\na",
        None,
    );
    assert!(
        runtime()
            .block_on(fetch(&client, &url, &path, TEST_ARTIFACT, &cancel, |_| {}))
            .is_err()
    );
    worker.join().unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"a");
    let (url, worker) = server(b"HTTP/1.1 206 Partial Content\r\nContent-Length: 2\r\nContent-Range: bytes 1-2/3\r\nConnection: close\r\n\r\nbc", Some("bytes=1-"));
    runtime()
        .block_on(fetch(&client, &url, &path, TEST_ARTIFACT, &cancel, |_| {}))
        .unwrap();
    worker.join().unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"abc");
    fs::write(&path, b"bad").unwrap();
    let (url, worker) = server(
        b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc",
        None,
    );
    runtime()
        .block_on(fetch(&client, &url, &path, TEST_ARTIFACT, &cancel, |_| {}))
        .unwrap();
    worker.join().unwrap();
    assert_eq!(fs::read(path).unwrap(), b"abc");
}

#[test]
fn corrupt_and_oversized_responses_are_rejected_and_verified_cache_is_offline() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test");
    let client = Client::new();
    let cancel = AtomicBool::new(false);
    let (url, worker) = server(
        b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nbad",
        None,
    );
    assert!(
        runtime()
            .block_on(fetch(&client, &url, &path, TEST_ARTIFACT, &cancel, |_| {}))
            .unwrap_err()
            .contains("checksum")
    );
    worker.join().unwrap();
    assert!(!path.exists());
    let (url, worker) = server(
        b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nabcd",
        None,
    );
    assert!(
        runtime()
            .block_on(fetch(&client, &url, &path, TEST_ARTIFACT, &cancel, |_| {}))
            .is_err()
    );
    worker.join().unwrap();
    assert!(fs::metadata(&path).unwrap().len() <= TEST_ARTIFACT.bytes);
    fs::write(&path, b"abc").unwrap();
    runtime()
        .block_on(fetch(
            &client,
            "http://127.0.0.1:1",
            &path,
            TEST_ARTIFACT,
            &cancel,
            |_| {},
        ))
        .unwrap();
}

#[test]
fn cancellation_keeps_partial_bytes_and_does_not_promote_an_install() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(staging(dir.path())).unwrap();
    let path = staging(dir.path()).join(ARTIFACTS[0].name);
    fs::write(&path, b"a").unwrap();
    let cancel = AtomicBool::new(true);
    assert!(
        install(dir.path(), &cancel, |_| {})
            .unwrap_err()
            .contains("cancelled")
    );
    assert!(!dir.path().join(REVISION).exists());
    assert_eq!(fs::read(&path).unwrap(), b"a");
    assert!(
        runtime()
            .block_on(fetch(
                &Client::new(),
                "http://127.0.0.1:1",
                &path,
                TEST_ARTIFACT,
                &cancel,
                |_| {}
            ))
            .is_err()
    );
    assert_eq!(fs::read(path).unwrap(), b"a");
    assert!(
        install_voice(
            dir.path(),
            &super::super::voices::CATALOG[0],
            &cancel,
            |_| {}
        )
        .is_err()
    );
    assert!(!dir.path().join("voice-downloads").exists());
}

#[test]
fn cancellation_after_a_written_chunk_preserves_that_chunk() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test");
    let cancel = AtomicBool::new(false);
    let (url, worker) = server(
        b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\nConnection: close\r\n\r\na",
        None,
    );
    assert!(
        runtime()
            .block_on(fetch(
                &Client::new(),
                &url,
                &path,
                TEST_ARTIFACT,
                &cancel,
                |_| cancel.store(true, Ordering::Release)
            ))
            .unwrap_err()
            .contains("cancelled")
    );
    worker.join().unwrap();
    assert_eq!(fs::read(path).unwrap(), b"a");
}

#[test]
fn disk_pressure_retains_storage_margin_and_handles_overflow() {
    assert!(check_space(STORAGE_MARGIN, 1).is_err());
    assert!(check_space(STORAGE_MARGIN + 3, 3).is_ok());
    assert!(check_space(u64::MAX, u64::MAX).is_err());
}

fn test_voice() -> &'static super::super::voices::Voice {
    static VOICE: std::sync::LazyLock<super::super::voices::Voice> =
        std::sync::LazyLock::new(|| super::super::voices::Voice {
            id: "fixture".into(),
            name: "Fixture".into(),
            locale: "en".into(),
            description: "Local test fixture".into(),
            file: "fixture.safetensors".into(),
            bytes: TEST_ARTIFACT.bytes,
            sha256: TEST_ARTIFACT.sha256.into(),
        });
    &VOICE
}

#[test]
fn optional_voice_promotes_verified_bytes_and_reuses_them_offline() {
    let root = tempfile::tempdir().unwrap();
    let voice = test_voice();
    let cancel = AtomicBool::new(false);
    let (url, worker) = server(
        b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc",
        None,
    );
    runtime()
        .block_on(install_voice_from(
            root.path(),
            voice,
            &url,
            &cancel,
            |_| {},
        ))
        .unwrap();
    worker.join().unwrap();
    let destination = super::super::voices::path(root.path(), &voice.id);
    let partial = super::super::voices::partial(root.path(), &voice.id);
    assert_eq!(fs::read(&destination).unwrap(), b"abc");
    assert!(!partial.exists());
    // Repeating the operation verifies the installed file without networking.
    runtime()
        .block_on(install_voice_from(
            root.path(),
            voice,
            "http://127.0.0.1:1",
            &cancel,
            |_| {},
        ))
        .unwrap();
    assert!(!root.path().join(REVISION).join(ARTIFACTS[0].name).exists());
    assert!(super::super::voices::installed(
        root.path(),
        super::super::DEFAULT_VOICE
    ));
}

#[test]
fn optional_voice_cancellation_keeps_verified_partial_without_promotion() {
    let root = tempfile::tempdir().unwrap();
    let voice = test_voice();
    let cancel = AtomicBool::new(false);
    let (url, worker) = server(
        b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc",
        None,
    );
    let result = runtime().block_on(install_voice_from(
        root.path(),
        voice,
        &url,
        &cancel,
        |_| cancel.store(true, Ordering::Release),
    ));
    worker.join().unwrap();
    assert!(result.is_err());
    assert!(!super::super::voices::path(root.path(), &voice.id).exists());
    assert_eq!(
        fs::read(super::super::voices::partial(root.path(), &voice.id)).unwrap(),
        b"abc"
    );
}
