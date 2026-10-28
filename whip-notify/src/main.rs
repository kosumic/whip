use std::io::Read;
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
use whip_notify::{
    Result,
    host::{Store, notification_preview, parse_event, renew_lease},
};

fn main() {
    if run().is_err() {
        // Never print event content, keys, relay capabilities, or provider errors.
        eprintln!(
            "whip-notify: operation failed (check installation, permissions, or relay availability)"
        );
        std::process::exit(1);
    }
}
fn run() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let mut command = args.next().ok_or("missing command")?;
    let (config, state) = if command == "--dirs" {
        let config = PathBuf::from(args.next().ok_or("missing config")?);
        let state = PathBuf::from(args.next().ok_or("missing state")?);
        command = args.next().ok_or("missing command")?;
        (config, state)
    } else {
        (
            PathBuf::from(std::env::var("HERDR_PLUGIN_CONFIG_DIR")?),
            PathBuf::from(std::env::var("HERDR_PLUGIN_STATE_DIR")?),
        )
    };
    let store = Store { config, state };
    match command.as_str() {
        "paths" => println!(
            "{}",
            serde_json::json!({"config":store.config,"state":store.state,"binary":std::env::current_exe()?,"protocol":1,"notification_previews":true})
        ),
        "identity" => {
            let key = store.identity()?;
            println!(
                "{}",
                serde_json::json!({"public_key":key.public_key,"host_id":whip_notify::key_id(&key.public_key)})
            );
        }
        "register" => {
            let mut input = Vec::new();
            std::io::stdin().take(16385).read_to_end(&mut input)?;
            if input.len() > 16384 {
                return Err("registration too large".into());
            }
            store.register(serde_json::from_slice(&input)?)?;
        }
        "unregister" => store.unregister(&args.next().ok_or("missing device")?)?,
        "lease" => {
            if args.next().as_deref() != Some("renew") {
                return Err("expected renew".into());
            }
            let device = args.next().ok_or("missing device")?;
            if !store.registrations()?.iter().any(|d| d.device_id == device) {
                return Err("unregistered device".into());
            }
            renew_lease(&store.state, &device)?;
        }
        "hook" => {
            let session = std::env::var("HERDR_SOCKET_PATH")?;
            let context =
                std::env::var("HERDR_PLUGIN_CONTEXT_JSON").unwrap_or_else(|_| "{}".into());
            let json = std::env::var("HERDR_PLUGIN_EVENT_JSON")?;
            if let Some(event) = parse_event(&json, &context, &session)? {
                let preview = notification_preview(&event, &json, &context)?;
                let deadline = Instant::now() + Duration::from_secs(4);
                whip_notify::host::deliver(&store, &event, &|device, envelope| {
                    let remaining = deadline
                        .checked_duration_since(Instant::now())
                        .ok_or("hook deadline")?;
                    let agent: ureq::Agent = ureq::Agent::config_builder()
                        .timeout_global(Some(remaining))
                        .max_redirects(0)
                        .build()
                        .into();
                    agent
                        .post(format!("{}/v1/push", device.relay_url))
                        .header("Authorization", format!("Bearer {}", device.route_token))
                        .send_json(device.push_request(envelope, &preview))?;
                    Ok(())
                })?;
            }
        }
        "uninstall" => {
            // Explicit administrator operation, after globally unlinking in Herdr.
            let _lock = store.lock()?;
            for device in store.registrations()? {
                let _ = std::fs::remove_file(store.state.join("leases").join(device.device_id));
            }
            for name in ["devices.json", "identity.json"] {
                let _ = std::fs::remove_file(store.config.join(name));
            }
        }
        _ => return Err("unknown command".into()),
    }
    Ok(())
}
