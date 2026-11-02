//! Shell-reported OSC 7 CWD. Never infer a shell's CWD from a new exec channel.

const MAX_OSC_BYTES: usize = 4096;

#[derive(Clone, Debug, Default)]
pub(super) struct ShellDirectory {
    pending: Vec<u8>,
    pub path: Option<String>,
}

impl ShellDirectory {
    pub fn observe(&mut self, bytes: &[u8]) -> bool {
        let previous = self.path.clone();
        for &byte in bytes {
            if self.pending.is_empty() {
                if byte == 0x1b {
                    self.pending.push(byte);
                }
                continue;
            }
            if self.pending.len() == 1 && byte != b']' {
                self.pending.clear();
                if byte == 0x1b {
                    self.pending.push(byte);
                }
                continue;
            }
            self.pending.push(byte);
            let terminated = byte == 7 || self.pending.ends_with(b"\x1b\\");
            if terminated {
                let end = self.pending.len() - if byte == 7 { 1 } else { 2 };
                if let Some(uri) = self.pending[2..end].strip_prefix(b"7;") {
                    // An invalid/new report clears the old repository association.
                    self.path = parse_directory(uri);
                }
                self.pending.clear();
            } else if self.pending.len() > MAX_OSC_BYTES {
                if self.pending.starts_with(b"\x1b]7;") {
                    self.path = None;
                }
                self.pending.clear();
            }
        }
        self.path != previous
    }
}

fn parse_directory(bytes: &[u8]) -> Option<String> {
    let value = std::str::from_utf8(bytes).ok()?;
    let uri = url::Url::parse(value).ok()?;
    if uri.scheme() != "file"
        || uri.query().is_some()
        || uri.fragment().is_some()
        || !uri.username().is_empty()
        || uri.password().is_some()
        || uri.port().is_some()
    {
        return None;
    }
    // Decode percent escapes without treating '+' as a space.
    let encoded = uri.path().as_bytes();
    let mut decoded = Vec::with_capacity(encoded.len());
    let mut index = 0;
    while index < encoded.len() {
        if encoded[index] == b'%' {
            let hex = std::str::from_utf8(encoded.get(index + 1..index + 3)?).ok()?;
            decoded.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            decoded.push(encoded[index]);
            index += 1;
        }
    }
    let path = String::from_utf8(decoded).ok()?;
    (path.starts_with('/') && !path.chars().any(char::is_control)).then_some(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_cwd_across_chunks_without_rendering_or_guessing() {
        let mut cwd = ShellDirectory::default();
        assert_eq!(cwd.path, None);
        assert!(!cwd.observe(b"prompt /untrusted/path\n\x1b]7;file://host/repo%20"));
        assert!(cwd.observe(b"name\x1b\\"));
        assert_eq!(cwd.path.as_deref(), Some("/repo name"));
        assert!(cwd.observe(b"\x1b]7;file://host/nested\x07"));
        assert_eq!(cwd.path.as_deref(), Some("/nested"));
        assert!(cwd.observe(b"\x1b]7;https://host/untrusted\x07"));
        assert_eq!(cwd.path, None);
    }

    #[test]
    fn rejects_unsafe_and_oversized_reports_and_resumes_parsing() {
        let mut cwd = ShellDirectory::default();
        for uri in [
            "file:///repo%00bad",
            "file:///repo%0Abad",
            "file:///repo%GG",
            "file:///repo?secret",
            "file://user:pass@host/repo",
        ] {
            cwd.observe(format!("\x1b]7;{uri}\x07").as_bytes());
            assert_eq!(cwd.path, None);
        }
        cwd.observe(format!("\x1b]7;file:///{}", "x".repeat(MAX_OSC_BYTES)).as_bytes());
        assert!(cwd.pending.len() <= MAX_OSC_BYTES);
        assert!(cwd.observe(b"\x1b]7;file:///valid\x07"));
        assert_eq!(cwd.path.as_deref(), Some("/valid"));
    }
}
