//! Two complete, credential-free calls using the same driver as Whip.
#[path = "../tests/support/flows.rs"]
mod flows;
#[path = "../tests/support/mod.rs"]
mod support;

#[tokio::main(flavor = "current_thread")]
async fn main() -> flows::TestResult {
    flows::realtime().await?;
    flows::live().await?;
    println!(
        "Independent Realtime and GPT-Live calls: PCM, tools, mute, interruption and final usage passed."
    );
    Ok(())
}
