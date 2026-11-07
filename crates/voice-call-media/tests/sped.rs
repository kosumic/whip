#![cfg(feature = "sped-benchmark")]
#[path = "../examples/support/handshake.rs"]
mod handshake;
use handshake::{Options, Pair, Result};
use std::time::Duration;
use str0m::{Event, Input, Output, SpedFallback, net::Protocol};

#[test]
fn negotiated_peers_deliver_authenticated_rtp_and_channel_four_over_udp_and_tcp() -> Result<()> {
    for protocol in [Protocol::Udp, Protocol::Tcp] {
        let mut pair = Pair::new(
            Options {
                protocol,
                ..Default::default()
            },
            None,
        )?;
        pair.run()?;
        assert!(pair.negotiated());
        assert!(pair.embedded > 0);
        assert!(pair.max_packet <= 1200);
        for peer in &pair.peers {
            assert!(peer.stages.ice <= peer.stages.ready);
            assert!(peer.stages.authenticated <= peer.stages.ready);
            assert!(peer.event_received && peer.stages.first_rtp.is_some());
        }
    }
    Ok(())
}
#[test]
fn an_ordinary_peer_and_an_advertised_but_broken_peer_fall_back() -> Result<()> {
    for protocol in [Protocol::Udp, Protocol::Tcp] {
        for blackhole in [false, true] {
            let mut pair = Pair::new(
                Options {
                    protocol,
                    remote_sped: false,
                    blackhole_sped: blackhole,
                    ..Default::default()
                },
                None,
            )?;
            pair.run()?;
            assert_eq!(pair.negotiated(), blackhole);
            assert_eq!(
                pair.peers[0].rtc.sped_stats().fallback,
                Some(if blackhole {
                    SpedFallback::NoEmbeddedResponse
                } else {
                    SpedFallback::Unsupported
                })
            );
            assert_eq!(pair.peers[1].rtc.sped_stats().embedded_sent, 0);
        }
    }
    Ok(())
}
#[test]
fn loss_and_high_rtt_do_not_bypass_authentication_or_break_data() -> Result<()> {
    let mut pair = Pair::new(
        Options {
            rtt: Duration::from_millis(180),
            loss_every: 7,
            ..Default::default()
        },
        None,
    )?;
    pair.run()?;
    assert!(pair.dropped > 0);
    assert!(pair.negotiated());
    Ok(())
}
#[test]
fn an_ice_restart_keeps_dtls_identity_and_allows_new_media() -> Result<()> {
    let mut pair = Pair::new(Options::default(), None)?;
    pair.run()?;
    let identity = pair.peers[0]
        .rtc
        .direct_api()
        .remote_dtls_fingerprint()
        .cloned();
    pair.restart_ice()?;
    pair.run()?;
    assert_eq!(
        pair.peers[0].rtc.direct_api().remote_dtls_fingerprint(),
        identity.as_ref()
    );
    assert!(pair.negotiated());
    Ok(())
}
#[test]
fn a_new_candidate_path_uses_direct_dtls_and_still_authenticates() -> Result<()> {
    let mut pair = Pair::new(Options::default(), None)?;
    pair.step()?;
    assert!(pair.embedded > 0);
    pair.change_path()?;
    pair.run()?;
    assert!(
        pair.peers
            .iter()
            .any(|p| p.rtc.sped_stats().fallback == Some(SpedFallback::PathChanged))
    );
    Ok(())
}
#[test]
fn early_checks_wait_for_the_sdp_answer_before_exposing_media() -> Result<()> {
    let delay = Duration::from_millis(100);
    let mut pair = Pair::new(
        Options {
            answer_delay: delay,
            remote_dtls_client: true,
            ..Default::default()
        },
        None,
    )?;
    while pair.now.duration_since(pair.start) < delay {
        pair.step()?;
        assert!(pair.peers[0].stages.ready.is_none());
        assert!(pair.peers[0].stages.first_rtp.is_none());
    }
    assert!(
        pair.embedded > 0,
        "answerer must actually send early embedded DTLS"
    );
    pair.run()?;
    assert!(pair.negotiated());
    assert!(pair.peers[0].rtc.sped_stats().embedded_received > 0);
    Ok(())
}
#[test]
fn a_wrong_sdp_fingerprint_never_becomes_ready() -> Result<()> {
    let mut pair = Pair::new(
        Options {
            bad_fingerprint: true,
            ..Default::default()
        },
        None,
    )?;
    assert!(pair.run().is_err());
    assert!(pair.peers[0].stages.ready.is_none());
    assert!(pair.peers[0].stages.first_rtp.is_none());
    assert!(!pair.peers[0].rtc.is_alive());
    Ok(())
}
#[test]
fn cancellation_discards_early_state_and_never_emits_ready_or_media() -> Result<()> {
    for buffered in [false, true] {
        let mut pair = Pair::new(
            Options {
                answer_delay: if buffered {
                    Duration::from_secs(1)
                } else {
                    Duration::ZERO
                },
                remote_dtls_client: buffered,
                ..Default::default()
            },
            None,
        )?;
        if buffered {
            for _ in 0..5 {
                pair.step()?;
            }
            assert!(pair.embedded > 0);
            assert!(pair.peers[0].stages.ready.is_none());
        }
        for peer in &mut pair.peers {
            peer.rtc.close()?;
            for tick in 0..200 {
                loop {
                    match peer.rtc.poll_output()? {
                        Output::Timeout(_) => break,
                        Output::Transmit(packet) => {
                            assert!(handshake::embedded_dtls(&packet.contents).is_none())
                        }
                        Output::Event(event) => assert!(!matches!(
                            event,
                            Event::Connected | Event::RtpPacket(_) | Event::ChannelData(_)
                        )),
                    }
                }
                peer.rtc
                    .handle_input(Input::Timeout(pair.now + Duration::from_millis(tick)))?;
                if !peer.rtc.is_alive() {
                    break;
                }
            }
            assert!(!peer.rtc.is_alive());
        }
    }
    Ok(())
}
