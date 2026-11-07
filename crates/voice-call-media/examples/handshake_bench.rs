//! Real cryptography with a simulated network clock; no API or device required.
#[path = "support/handshake.rs"]
mod handshake;
use handshake::{Options, Pair, Result, Stages, material};
use std::time::{Duration, Instant};
use str0m::net::Protocol;

fn percentile(mut values: Vec<f64>, percent: usize) -> f64 {
    values.sort_by(f64::total_cmp);
    values[(values.len() * percent).div_ceil(100).saturating_sub(1)]
}
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let iterations: usize = args.get(1).map_or(Ok(30), |arg| arg.parse())?;
    let rtt_ms: u64 = args.get(2).map_or(Ok(40), |arg| arg.parse())?;
    let loss_every: usize = args.get(3).map_or(Ok(0), |arg| arg.parse())?;
    if iterations == 0 {
        return Err("iterations must be positive".into());
    }
    println!(
        "# real ICE/DTLS/SCTP/SRTP; simulated clock; no HTTP, device, audio or OS-network measurement"
    );
    println!(
        "mode,cache,protocol,rtt_ms,loss_every,iterations,negotiated,embedded,fallbacks,failures,stage,p50_ms,p95_ms"
    );
    for protocol in [Protocol::Udp, Protocol::Tcp] {
        for warm in [false, true] {
            for sped in [false, true] {
                if sped && !cfg!(feature = "sped-benchmark") {
                    continue;
                }
                let mut samples = Vec::new();
                let mut setup = Vec::new();
                let mut handshake_wall = Vec::new();
                let mut negotiated = 0;
                let mut embedded = 0;
                let mut failures = 0;
                let mut fallbacks = 0;
                for _ in 0..iterations {
                    // Fresh certificates each call; warm preparation shifts only
                    // their generation outside the timed construction interval.
                    let prepared = if warm { Some(material()?) } else { None };
                    let at = Instant::now();
                    let mut pair = Pair::new(
                        Options {
                            sped,
                            protocol,
                            rtt: Duration::from_millis(rtt_ms),
                            loss_every,
                            ..Default::default()
                        },
                        prepared,
                    )?;
                    setup.push(at.elapsed().as_secs_f64() * 1000.0);
                    let handshake_at = Instant::now();
                    let result = pair.run();
                    negotiated += usize::from(pair.negotiated());
                    embedded += usize::from(pair.embedded > 0);
                    fallbacks += usize::from(pair.fell_back());
                    if let Err(error) = result {
                        eprintln!("handshake failed: {error}");
                        failures += 1;
                        continue;
                    }
                    handshake_wall.push(handshake_at.elapsed().as_secs_f64() * 1000.0);
                    samples.push(pair.peers[0].stages.clone());
                }
                let prefix = format!(
                    "{},{},{protocol:?},{rtt_ms},{loss_every},{iterations},{negotiated},{embedded},{fallbacks},{failures}",
                    if sped { "sped" } else { "baseline" },
                    if warm { "warm" } else { "cold" }
                );
                println!(
                    "{prefix},construction_wall,{:.3},{:.3}",
                    percentile(setup.clone(), 50),
                    percentile(setup, 95)
                );
                if samples.is_empty() {
                    return Err("No successful handshakes".into());
                }
                println!(
                    "{prefix},handshake_wall,{:.3},{:.3}",
                    percentile(handshake_wall.clone(), 50),
                    percentile(handshake_wall, 95)
                );

                type Stage = (&'static str, fn(&Stages) -> Option<Duration>);
                let stages: &[Stage] = &[
                    ("ice", |s| s.ice),
                    ("dtls_authenticated", |s| s.authenticated),
                    ("dtls_from_first_flight", |s| {
                        Some(s.authenticated? - s.dtls_start?)
                    }),
                    ("data_channel_open", |s| s.channel_open),
                    ("data_channel_authenticated", |s| s.channel),
                    ("first_authenticated_rtp", |s| s.first_rtp),
                    ("transport_ready", |s| s.ready),
                ];
                for (name, stage) in stages {
                    let values: Vec<_> = samples
                        .iter()
                        .filter_map(stage)
                        .map(|v| v.as_secs_f64() * 1000.0)
                        .collect();
                    if !values.is_empty() {
                        println!(
                            "{prefix},{name},{:.3},{:.3}",
                            percentile(values.clone(), 50),
                            percentile(values, 95)
                        );
                    }
                }
            }
        }
    }
    Ok(())
}
