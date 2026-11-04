//! RTP framing per RFC 3550. Header extensions, CSRCs and padding are not Opus data.
pub(super) struct Packet {
    pub sequence: u16,
    pub timestamp: u32,
    pub payload: Vec<u8>,
}
pub(super) fn parse(bytes: &[u8]) -> Option<Packet> {
    if bytes.len() < 12 || bytes[0] >> 6 != 2 {
        return None;
    }
    let mut offset = 12 + usize::from(bytes[0] & 0x0f) * 4;
    if bytes[0] & 0x10 != 0 {
        let header = bytes.get(offset..offset + 4)?;
        offset += 4 + usize::from(u16::from_be_bytes([header[2], header[3]])) * 4;
    }
    let mut end = bytes.len();
    if bytes[0] & 0x20 != 0 {
        let padding = usize::from(*bytes.last()?);
        if padding == 0 {
            return None;
        }
        end = end.checked_sub(padding)?;
    }
    if offset >= end {
        return None;
    }
    Some(Packet {
        sequence: u16::from_be_bytes([bytes[2], bytes[3]]),
        timestamp: u32::from_be_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]),
        payload: bytes.get(offset..end)?.to_vec(),
    })
}
pub(super) fn distance(sequence: u16, expected: u16) -> i16 {
    i16::from_ne_bytes(sequence.wrapping_sub(expected).to_ne_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rtp_extensions_padding_and_sequence_wrap_preserve_only_opus_payload()
    -> Result<(), &'static str> {
        let mut wire = vec![0xb1, 111, 0xff, 0xff, 0, 0, 3, 0xc0, 0, 0, 0, 1];
        wire.extend_from_slice(&[
            0, 0, 0, 2, 0xbe, 0xde, 0, 1, 1, 2, 3, 4, 0xf8, 0xff, 0xfe, 0, 2,
        ]);
        let packet = parse(&wire).ok_or("valid RTP")?;
        assert_eq!(packet.sequence, u16::MAX);
        assert_eq!(packet.timestamp, 960);
        assert_eq!(packet.payload, [0xf8, 0xff, 0xfe]);
        assert_eq!(distance(0, u16::MAX), 1);
        assert_eq!(distance(u16::MAX, 0), -1);
        for length in 0..24 {
            assert!(parse(&wire[..length]).is_none());
        }
        Ok(())
    }
}
