use super::*;

fn fixture(usage: serde_json::Value) -> Vec<u8> {
    format!(": heartbeat\r\nevent: speech.audio.delta\r\ndata: {{\"type\":\"speech.audio.delta\",\"audio\":\"{}\"}}\r\n\r\ndata: {{\"type\":\"speech.audio.delta\",\"audio\":\"{}\"}}\r\n\r\ndata: {{\"type\":\"speech.audio.done\",\"usage\":{usage}}}\r\n\r\n", STANDARD.encode([0]), STANDARD.encode([128, 255, 127])).into_bytes()
}

#[test]
fn fragmented_sse_stream_preserves_pcm_and_reports_provider_tokens_and_price_once() {
    for chunk_size in [1, 3, 17, 4096] {
        let mut stream = SpeechStream::default();
        let mut pcm = Vec::new();
        let mut usage = Vec::new();
        let bytes =
            fixture(serde_json::json!({"input_tokens":100,"output_tokens":200,"total_tokens":300}));
        for chunk in bytes.chunks(chunk_size) {
            assert!(
                stream
                    .push(
                        chunk,
                        &mut |samples| {
                            pcm.extend_from_slice(samples);
                            true
                        },
                        &mut |item| usage.push(item)
                    )
                    .unwrap()
            );
        }
        assert!(
            stream
                .finish(&mut |_| true, &mut |item| usage.push(item))
                .unwrap()
        );
        assert_eq!(pcm, [-1.0, 32767.0 / 32768.0]);
        assert_eq!(usage.len(), 1);
        let item = &usage[0];
        assert!((item.estimated_usd.unwrap() - 0.00246).abs() < 1e-12);
        assert_eq!(item.reported_usage.len(), 2);
        assert_eq!(item.reported_usage[0].amount, 100.0);
        assert_eq!(item.reported_usage[1].amount, 200.0);
        assert!(item.finalized);
        assert_eq!(
            item.price_snapshot.as_ref().unwrap().effective_at_ms,
            1_793_750_400_000
        );
        stream
            .push(
                b"data: {\"type\":\"speech.audio.done\",\"usage\":null}\n\n",
                &mut |_| true,
                &mut |item| usage.push(item),
            )
            .unwrap();
        assert_eq!(usage.len(), 1);
    }
}

#[test]
fn absent_or_inconsistent_usage_never_turns_valid_audio_into_a_free_request() {
    for report in [
        serde_json::Value::Null,
        serde_json::json!({"input_tokens":10,"output_tokens":20,"total_tokens":999}),
    ] {
        let mut stream = SpeechStream::default();
        let mut usage = Vec::new();
        stream
            .push(&fixture(report), &mut |_| true, &mut |item| {
                usage.push(item)
            })
            .unwrap();
        assert!(
            stream
                .finish(&mut |_| true, &mut |item| usage.push(item))
                .unwrap()
        );
        assert_eq!(usage.len(), 1);
        assert!(usage[0].estimated_usd.is_none());
        assert!(!usage[0].finalized);
    }
}

#[test]
fn interrupted_or_malformed_streams_cannot_invent_final_usage_or_expose_provider_errors() {
    let mut stream = SpeechStream::default();
    let mut reports = Vec::new();
    assert!(
        !stream
            .push(
                b"data: {\"type\":\"speech.audio.delta\",\"audio\":\"AAA=\"}\n\n",
                &mut |_| false,
                &mut |item| reports.push(item)
            )
            .unwrap()
    );
    assert!(reports.is_empty());
    let mut stream = SpeechStream::default();
    stream
        .push(
            b"data: {\"type\":\"speech.audio.delta\",\"audio\":\"AAA=\"}\n\n",
            &mut |_| true,
            &mut |_| {},
        )
        .unwrap();
    assert!(stream.finish(&mut |_| true, &mut |_| {}).is_err());
    let mut stream = SpeechStream::default();
    let error = stream
        .push(
            b"data: {\"type\":\"error\",\"message\":\"sk-private transcript\"}\n\n",
            &mut |_| true,
            &mut |_| {},
        )
        .unwrap_err();
    assert!(!error.contains("sk-private"));
    assert!(!error.contains("transcript"));
}
