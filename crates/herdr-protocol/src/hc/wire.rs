//! Generation-1 framing, selectively adapted from herdr-core/src/wire.rs.
//! No transport I/O; a decoder accepts arbitrary SSH read boundaries.
use super::Error;

pub const HEADER_BYTES: usize = 9;
pub const MAX_PAYLOAD_BYTES: usize = 16 * 1024 * 1024;
pub const INITIAL_CREDIT: usize = 256 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Kind {
    Data = 0,
    Credit = 1,
    Close = 2,
    Resize = 3,
    Focus = 4,
    Facts = 5,
}

impl TryFrom<u8> for Kind {
    type Error = Error;
    fn try_from(value: u8) -> Result<Self, Error> {
        match value {
            0 => Ok(Self::Data),
            1 => Ok(Self::Credit),
            2 => Ok(Self::Close),
            3 => Ok(Self::Resize),
            4 => Ok(Self::Focus),
            5 => Ok(Self::Facts),
            _ => Err(Error::InvalidFrame("unknown frame kind")),
        }
    }
}

fn validate(kind: Kind, length: usize) -> Result<(), Error> {
    if length > MAX_PAYLOAD_BYTES {
        return Err(Error::FrameTooLarge(length));
    }
    match kind {
        Kind::Credit | Kind::Resize if length != 4 => {
            Err(Error::InvalidFrame("expected four-byte payload"))
        }
        Kind::Focus if length != 1 => Err(Error::InvalidFrame("expected one-byte focus payload")),
        _ => Ok(()),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Frame {
    pub channel: u32,
    pub kind: Kind,
    pub payload: Vec<u8>,
}

impl Frame {
    pub fn encode(&self) -> Result<Vec<u8>, Error> {
        validate(self.kind, self.payload.len())?;
        validate_payload(self)?;
        let length = u32::try_from(self.payload.len())
            .map_err(|_| Error::FrameTooLarge(self.payload.len()))?;
        let mut bytes = Vec::with_capacity(HEADER_BYTES + self.payload.len());
        bytes.extend_from_slice(&self.channel.to_le_bytes());
        bytes.push(self.kind as u8);
        bytes.extend_from_slice(&length.to_le_bytes());
        bytes.extend_from_slice(&self.payload);
        Ok(bytes)
    }
}

#[derive(Default, Debug)]
pub struct Decoder {
    header: [u8; HEADER_BYTES],
    header_len: usize,
    frame: Option<Frame>,
    payload_len: usize,
}

impl Decoder {
    /// Validate a complete header before reserving any payload memory.
    pub fn push(&mut self, mut bytes: &[u8]) -> Result<Vec<Frame>, Error> {
        let mut frames = Vec::new();
        while !bytes.is_empty() {
            if self.frame.is_none() {
                let count = (HEADER_BYTES - self.header_len).min(bytes.len());
                self.header[self.header_len..self.header_len + count]
                    .copy_from_slice(&bytes[..count]);
                self.header_len += count;
                bytes = &bytes[count..];
                if self.header_len < HEADER_BYTES {
                    break;
                }
                let kind = Kind::try_from(self.header[4])?;
                self.payload_len = u32::from_le_bytes([
                    self.header[5],
                    self.header[6],
                    self.header[7],
                    self.header[8],
                ]) as usize;
                validate(kind, self.payload_len)?;
                self.frame = Some(Frame {
                    channel: u32::from_le_bytes([
                        self.header[0],
                        self.header[1],
                        self.header[2],
                        self.header[3],
                    ]),
                    kind,
                    payload: Vec::with_capacity(self.payload_len),
                });
            }
            if let Some(frame) = self.frame.as_mut() {
                let count = (self.payload_len - frame.payload.len()).min(bytes.len());
                frame.payload.extend_from_slice(&bytes[..count]);
                bytes = &bytes[count..];
                if frame.payload.len() == self.payload_len {
                    if let Some(frame) = self.frame.take() {
                        validate_payload(&frame)?;
                        frames.push(frame);
                    }
                    self.header_len = 0;
                }
            }
        }
        Ok(frames)
    }

    pub fn end(&self) -> Result<(), Error> {
        if self.header_len == 0 && self.frame.is_none() {
            Ok(())
        } else {
            Err(Error::InvalidFrame("truncated frame"))
        }
    }
}

fn validate_payload(frame: &Frame) -> Result<(), Error> {
    if frame.kind == Kind::Focus && !matches!(frame.payload.first(), Some(0 | 1)) {
        return Err(Error::InvalidFrame("focus must be zero or one"));
    }
    Ok(())
}
