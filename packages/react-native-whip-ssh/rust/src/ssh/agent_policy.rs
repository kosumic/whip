//! Keep forwarded RSA signing subject to the same SHA-2 policy as SSH login.

use std::io;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use zeroize::Zeroizing;

use super::AgentIo;

const MAX_FRAME_BYTES: usize = 256 * 1024;
const SIGN_REQUEST: u8 = 13;
const AGENT_FAILURE: &[u8] = &[0, 0, 0, 1, 5];
const RSA_SHA2_256: u32 = 2;
const RSA_SHA2_512: u32 = 4;

pub(super) fn protect_rsa_signing(stream: Box<dyn AgentIo>) -> Box<dyn AgentIo> {
    let (accepted, backend) = tokio::io::duplex(MAX_FRAME_BYTES);
    tokio::spawn(async move {
        // EOF and malformed frames close only this forwarded agent connection.
        let _ = relay(stream, accepted).await;
    });
    Box::new(backend)
}

async fn relay(
    mut client: impl AsyncRead + AsyncWrite + Unpin,
    mut agent: impl AsyncRead + AsyncWrite + Unpin,
) -> io::Result<()> {
    loop {
        let request = read_frame(&mut client).await?;
        if request.first() == Some(&SIGN_REQUEST) && !uses_rsa_sha2(&request) {
            client.write_all(AGENT_FAILURE).await?;
            continue;
        }
        write_frame(&mut agent, &request).await?;
        let response = read_frame(&mut agent).await?;
        write_frame(&mut client, &response).await?;
    }
}

fn uses_rsa_sha2(request: &[u8]) -> bool {
    let mut fields = &request[1..];
    // SSH_AGENTC_SIGN_REQUEST contains a public-key string, a data string, and
    // exactly one flags word. Reject trailing bytes as well as truncated fields.
    for _ in 0..2 {
        let Some(length) = fields.get(..4).and_then(|word| word.try_into().ok()) else {
            return false;
        };
        let Some(rest) = fields
            .get(4..)
            .and_then(|rest| rest.get(u32::from_be_bytes(length) as usize..))
        else {
            return false;
        };
        fields = rest;
    }
    fields
        .try_into()
        .ok()
        .is_some_and(|word| matches!(u32::from_be_bytes(word), RSA_SHA2_256 | RSA_SHA2_512))
}

async fn read_frame(stream: &mut (impl AsyncRead + Unpin)) -> io::Result<Zeroizing<Vec<u8>>> {
    let length = stream.read_u32().await? as usize;
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid SSH agent frame length",
        ));
    }
    let mut frame = Zeroizing::new(vec![0; length]);
    stream.read_exact(&mut frame).await?;
    Ok(frame)
}

async fn write_frame(stream: &mut (impl AsyncWrite + Unpin), frame: &[u8]) -> io::Result<()> {
    let length = u32::try_from(frame.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "SSH agent frame too large"))?;
    stream.write_u32(length).await?;
    stream.write_all(frame).await
}
