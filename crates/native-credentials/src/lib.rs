//! Native-only credential ingress. No UniFFI, serialization, Debug or secret handles.
use std::ffi::c_void;
use zeroize::Zeroizing;

pub const MAX_KEY_BYTES: usize = 1024;
pub type ReadCredential = unsafe extern "C" fn(*mut c_void, *mut u8, usize) -> i32;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(i32)]
pub enum CredentialError {
    Missing = -1,
    Locked = -2,
    Unavailable = -3,
    Failed = -4,
}

/// Native-only key storage. Cached keys and short-lived request copies zero on drop.
#[derive(Clone)]
pub struct NativeCredential {
    bytes: Zeroizing<Vec<u8>>,
    length: usize,
}

impl NativeCredential {
    /// # Safety
    /// The callback must synchronously write at most capacity bytes and retain no
    /// pointers. Its context must remain valid for this call only.
    pub unsafe fn read(
        reader: ReadCredential,
        context: *mut c_void,
    ) -> Result<Self, CredentialError> {
        let mut bytes = Zeroizing::new(vec![0; MAX_KEY_BYTES]);
        // SAFETY: The caller supplies a synchronous callback and live context;
        // bytes is a uniquely borrowed buffer of exactly MAX_KEY_BYTES bytes.
        let count = unsafe { reader(context, bytes.as_mut_ptr(), bytes.len()) };
        match count {
            -1 => return Err(CredentialError::Missing),
            -2 => return Err(CredentialError::Locked),
            -3 => return Err(CredentialError::Unavailable),
            count if count <= 0 => return Err(CredentialError::Failed),
            _ => {}
        }
        let count = usize::try_from(count).map_err(|_| CredentialError::Failed)?;
        if count > MAX_KEY_BYTES {
            return Err(CredentialError::Failed);
        }
        // API authorization headers require printable ASCII, without spaces.
        if !bytes[..count]
            .iter()
            .all(|byte| (b'!'..=b'~').contains(byte))
        {
            return Err(CredentialError::Failed);
        }
        Ok(Self {
            bytes,
            length: count,
        })
    }

    pub fn authorization(&self) -> Zeroizing<Vec<u8>> {
        let mut header = Zeroizing::new(Vec::with_capacity(7 + self.length));
        header.extend_from_slice(b"Bearer ");
        header.extend_from_slice(&self.bytes[..self.length]);
        header
    }
}

#[cfg(test)]
mod tests {
    use super::{CredentialError, NativeCredential};
    use std::ffi::c_void;

    unsafe extern "C" fn fixture(context: *mut c_void, out: *mut u8, capacity: usize) -> i32 {
        // SAFETY: Each test passes a live i32 fixture for this synchronous call.
        let code = unsafe { *context.cast::<i32>() };
        if code == 7 && capacity >= 7 {
            // SAFETY: The caller lends capacity bytes; fixture is seven bytes.
            unsafe { std::ptr::copy_nonoverlapping(b"sk-test".as_ptr(), out, 7) };
        }
        code
    }

    #[test]
    fn native_statuses_are_typed_and_invalid_results_fail_closed() {
        for (mut code, expected) in [
            (-1, CredentialError::Missing),
            (-2, CredentialError::Locked),
            (-3, CredentialError::Unavailable),
            (-4, CredentialError::Failed),
            (0, CredentialError::Failed),
            (1025, CredentialError::Failed),
            (8, CredentialError::Failed), // Uninitialized / non-ASCII data.
        ] {
            // SAFETY: fixture follows the callback contract and code is live.
            let result = unsafe { NativeCredential::read(fixture, (&raw mut code).cast()) };
            assert_eq!(result.err(), Some(expected));
        }
    }

    #[test]
    fn credential_goes_only_into_a_sensitive_request_header() {
        let mut code = 7;
        // SAFETY: fixture follows the callback contract and code is live.
        let key = unsafe { NativeCredential::read(fixture, (&raw mut code).cast()) };
        assert_eq!(
            key.map(|key| key.authorization().to_vec()),
            Ok(b"Bearer sk-test".to_vec())
        );
    }
}
