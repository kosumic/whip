//! Launch-scoped Codex context injection, independent of deferred MCP tools.
use serde_json::json;
use sha2::{Digest, Sha256};

pub(super) const PATH_SUFFIX: &str = "/instructions";
const HOOK_KEY: &str = "/<session-flags>/config.toml:session_start:0:0";
const HOOK_TIMEOUT_SECONDS: u64 = 10;
const HOOK_STATUS: &str = "Loading Whip instructions";

pub(super) fn command(url: &str, token: &str) -> Result<String, String> {
    let request = shlex::try_join([
        "curl",
        "--disable",
        "--noproxy",
        "*",
        "--silent",
        "--show-error",
        "--fail",
        "--max-time",
        &HOOK_TIMEOUT_SECONDS.to_string(),
        "--header",
        &format!("Authorization: Bearer {token}"),
        &format!("{url}{PATH_SUFFIX}"),
    ])
    .map_err(|error| error.to_string())?;
    let failure = shlex::try_join([
        "printf", "%s",
        &json!({"continue":false,"stopReason":"Could not load Whip instructions. Open and unlock Whip, then retry."}).to_string(),
    ]).map_err(|error| error.to_string())?;
    // Capture first, so a failed/partial transfer never reaches the hook parser.
    // Quoted printf treats instruction text as data, including shell syntax.
    let script = format!(
        "if whip_context=$({request}); then printf '%s' \"$whip_context\"; else {failure}; fi"
    );
    // The SSH user's interactive shell may be fish rather than a POSIX shell.
    // Keep quoting free of backslash escapes: Herdr sends POSIX-quoted arguments
    // through that shell, and fish interprets backslashes inside single quotes.
    Ok(format!(
        "/bin/sh -c {}",
        crate::remote_ops::shell_quote(&script)
    ))
}

pub(super) fn codex_config(url: &str, token: &str) -> Result<Vec<String>, String> {
    let command = command(url, token)?;
    // Codex fingerprints the normalized hook declaration as sorted JSON. Trust
    // only this generated read-only handler for this launch; never bypass trust
    // for the user's other hooks or modify their persisted configuration.
    let mut identity = json!({
        "event_name":"session_start",
        "hooks":[{
            "type":"command", "command":command,
            "timeout":HOOK_TIMEOUT_SECONDS, "async":false,
            "additionalContextLimit":0, "statusMessage":HOOK_STATUS,
        }],
    });
    identity.sort_all_objects();
    let fingerprint = crate::lower_hex(&Sha256::digest(identity.to_string().as_bytes()));
    let command = serde_json::to_string(&command).map_err(|error| error.to_string())?;
    let key = serde_json::to_string(HOOK_KEY).map_err(|error| error.to_string())?;
    let status = serde_json::to_string(HOOK_STATUS).map_err(|error| error.to_string())?;
    Ok(vec![
        "-c".into(),
        format!(
            "hooks.SessionStart=[{{hooks=[{{type=\"command\",command={command},timeout={HOOK_TIMEOUT_SECONDS},additionalContextLimit=0,statusMessage={status}}}]}}]"
        ),
        "-c".into(),
        format!("hooks.state={{{key}={{trusted_hash=\"sha256:{fingerprint}\",enabled=true}}}}"),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires installed Codex, Node and fish; uses hooks/list without a model call"]
    fn codex_accepts_and_trusts_only_the_generated_startup_hook()
    -> Result<(), Box<dyn std::error::Error>> {
        let directory = tempfile::tempdir()?;
        let mut args = codex_config("http://127.0.0.1:9/mcp/contract", "contract-token")?;
        args.push("app-server".into());
        // Herdr types a POSIX-quoted command into the user's interactive shell.
        // Direct argv spawning alone misses fish's single-quote escape rules.
        let launch = std::iter::once("codex")
            .chain(args.iter().map(String::as_str))
            .map(crate::remote_ops::shell_quote)
            .collect::<Vec<_>>()
            .join(" ");
        let script = r"
const { spawn } = require('node:child_process');
function inspect([program, ...args]) {
  return new Promise(resolve => {
    const child = spawn(program, args, { cwd: process.argv[2], stdio: ['pipe', 'pipe', 'pipe'] });
    let done = false;
    const finish = hooks => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve(hooks);
    };
    const timer = setTimeout(() => finish(null), 15000);
    let buffer = '';
    child.stderr.resume();
    child.stdout.on('data', chunk => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let value;
        try { value = JSON.parse(line); } catch { continue; }
        if (value.id === 1) {
          child.stdin.write(JSON.stringify({method:'initialized'}) + '\n');
          child.stdin.write(JSON.stringify({id:2,method:'hooks/list',params:{cwds:[process.argv[2]]}}) + '\n');
        }
        if (value.id === 2) finish(value.result?.data.flatMap(entry => entry.hooks));
      }
    });
    child.on('error', () => finish(null));
    child.on('exit', () => finish(null));
    child.stdin.write(JSON.stringify({id:1,method:'initialize',params:{clientInfo:{name:'whip-hook-contract',version:'1'},capabilities:{experimentalApi:true}}}) + '\n');
  });
}
(async () => {
  const before = await inspect(['codex', 'app-server']);
  const launches = [
    ['codex', ...JSON.parse(process.argv[1])],
    ['/bin/sh', '-c', process.argv[3]],
    ['fish', '--no-config', '-c', process.argv[3]],
  ];
  for (const launch of launches) {
    const after = await inspect(launch);
    const own = after?.find(hook => hook.key === '/<session-flags>/config.toml:session_start:0:0');
    const preserved = before?.every(previous => {
      const current = after?.find(hook => hook.key === previous.key);
      return current?.trustStatus === previous.trustStatus && current?.enabled === previous.enabled && current?.command === previous.command;
    });
    const passed = own?.statusMessage === 'Loading Whip instructions' && own?.trustStatus === 'trusted' && own?.enabled === true && own?.additionalContextLimit === 0 && preserved;
    if (!passed) {
      process.stderr.write(JSON.stringify({program:launch[0],found:!!own,trustStatus:own?.trustStatus,preserved}) + '\n');
      process.exitCode = 1;
    }
  }
})().catch(() => { process.exitCode = 1; });
";
        let status = std::process::Command::new("node")
            .args(["-e", script, &serde_json::to_string(&args)?])
            .arg(directory.path())
            .arg(launch)
            .status()?;
        assert!(
            status.success(),
            "Codex did not accept the startup hook's declaration and scoped trust"
        );
        Ok(())
    }
}
