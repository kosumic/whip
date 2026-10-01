use std::{
    collections::HashSet,
    io::{self, Write as _},
    net::IpAddr,
    process::Command,
};

use if_addrs::get_if_addrs;

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct AddressCandidate {
    pub interface: String,
    pub address: IpAddr,
    pub label: String,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub enum AddressSelection {
    Discovered(AddressCandidate),
    Other,
}

pub fn discover_address_candidates() -> io::Result<Vec<AddressCandidate>> {
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();
    for interface in get_if_addrs()? {
        let address = interface.ip();
        if !is_usable(&interface.name, address) || !seen.insert(address) {
            continue;
        }
        candidates.push(AddressCandidate {
            label: label_for(&interface.name, address),
            interface: interface.name,
            address,
        });
    }
    if let Some(address) = discover_public_address()
        && seen.insert(address)
    {
        candidates.push(AddressCandidate {
            label: "Public".into(),
            interface: "ifconfig.me".into(),
            address,
        });
    }
    candidates.sort_by_key(candidate_rank);
    Ok(candidates)
}

fn discover_public_address() -> Option<IpAddr> {
    let output = Command::new("curl")
        .args([
            "--fail",
            "--silent",
            "--show-error",
            "--max-time",
            "3",
            "https://ifconfig.me/ip",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_public_address(&output.stdout)
}

fn parse_public_address(output: &[u8]) -> Option<IpAddr> {
    let address = std::str::from_utf8(output).ok()?.trim().parse().ok()?;
    is_usable("ifconfig.me", address).then_some(address)
}

pub fn select_address(candidates: &[AddressCandidate]) -> Result<AddressSelection, String> {
    eprintln!("Choose how Whip will reach this host:\n");
    for (index, candidate) in candidates.iter().enumerate() {
        eprintln!(
            "  {}. {:<12} {:<39} {}",
            index + 1,
            candidate.label,
            candidate.address,
            candidate.interface
        );
    }
    let other_index = candidates.len() + 1;
    eprintln!(
        "  {other_index}. {:<12} Enter a public IP address or hostname",
        "Public/other"
    );
    eprint!("\nSelection [1]: ");
    std::io::stderr()
        .flush()
        .map_err(|error| error.to_string())?;
    let mut answer = String::new();
    std::io::stdin()
        .read_line(&mut answer)
        .map_err(|error| error.to_string())?;
    let selected = if answer.trim().is_empty() {
        1
    } else {
        answer
            .trim()
            .parse::<usize>()
            .map_err(|_| "selection must be a number".to_owned())?
    };
    if selected == other_index {
        return Ok(AddressSelection::Other);
    }
    candidates
        .get(selected.saturating_sub(1))
        .cloned()
        .map(AddressSelection::Discovered)
        .ok_or_else(|| "selection is outside the displayed range".into())
}

fn is_usable(interface: &str, address: IpAddr) -> bool {
    if address.is_loopback() || address.is_unspecified() || address.is_multicast() {
        return false;
    }
    let lower = interface.to_ascii_lowercase();
    if [
        "docker", "podman", "virbr", "veth", "cni", "flannel", "kube", "br-",
    ]
    .iter()
    .any(|prefix| lower.starts_with(prefix))
    {
        return false;
    }
    match address {
        IpAddr::V4(address) => !address.is_link_local(),
        IpAddr::V6(address) => !address.is_unicast_link_local(),
    }
}

fn label_for(interface: &str, address: IpAddr) -> String {
    let lower = interface.to_ascii_lowercase();
    if lower.starts_with("tailscale") || is_tailscale_address(address) {
        "Tailscale".into()
    } else if lower.starts_with("wl") || matches!(lower.as_str(), "en0" | "en1") {
        "Wi-Fi".into()
    } else if lower.starts_with("en") || lower.starts_with("eth") {
        "Ethernet".into()
    } else {
        "Network".into()
    }
}

fn candidate_rank(candidate: &AddressCandidate) -> (u8, u8, String) {
    let network_rank = match candidate.label.as_str() {
        "Tailscale" => 0,
        "Wi-Fi" => 1,
        "Ethernet" => 2,
        "Public" => 3,
        _ => 4,
    };
    let family_rank = u8::from(!candidate.address.is_ipv4());
    (network_rank, family_rank, candidate.interface.clone())
}

fn is_tailscale_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            let octets = address.octets();
            octets[0] == 100 && (64..=127).contains(&octets[1])
        }
        IpAddr::V6(address) => address.segments()[0] == 0xfd7a,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranks_tailscale_before_lan() {
        let mut candidates = [
            AddressCandidate {
                interface: "wlan0".into(),
                address: "192.168.1.10".parse().unwrap(),
                label: "Wi-Fi".into(),
            },
            AddressCandidate {
                interface: "tailscale0".into(),
                address: "100.80.0.5".parse().unwrap(),
                label: "Tailscale".into(),
            },
        ];
        candidates.sort_by_key(candidate_rank);
        assert_eq!(candidates[0].interface, "tailscale0");
    }

    #[test]
    fn filters_container_and_link_local_addresses() {
        assert!(!is_usable("docker0", "172.17.0.1".parse().unwrap()));
        assert!(!is_usable("wlan0", "169.254.1.2".parse().unwrap()));
        assert!(is_usable("wlan0", "192.168.1.2".parse().unwrap()));
    }

    #[test]
    fn parses_public_ip_response() {
        assert_eq!(
            parse_public_address(b"203.0.113.10\n"),
            Some("203.0.113.10".parse().unwrap())
        );
        assert_eq!(
            parse_public_address(b"2001:db8::10\n"),
            Some("2001:db8::10".parse().unwrap())
        );
        assert_eq!(parse_public_address(b"not an address\n"), None);
    }
}
