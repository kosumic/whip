//! Shared OpenAI credential ingress for speech and conversation adapters.
use native_credentials::{CredentialError, NativeCredential, ReadCredential};
use parking_lot::Mutex;
use std::ffi::c_void;
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Default)]
struct CredentialState {
    updating: bool,
    cached: Option<NativeCredential>,
}

impl CredentialState {
    fn set_updating(&mut self, updating: bool) {
        self.updating = updating;
        if updating {
            // Dropping the native credential zeroes its retained plaintext.
            self.cached = None;
        }
    }

    /// The reader and context follow NativeCredential::read's contract.
    unsafe fn read(
        &mut self,
        reader: Option<ReadCredential>,
        context: *mut c_void,
    ) -> Result<NativeCredential, CredentialError> {
        if self.updating {
            return Err(CredentialError::Unavailable);
        }
        if let Some(credential) = &self.cached {
            return Ok(credential.clone());
        }
        let reader = reader.ok_or(CredentialError::Unavailable)?;
        // SAFETY: The caller supplies a synchronous reader and live context.
        let credential = unsafe { NativeCredential::read(reader, context) }?;
        self.cached = Some(credential.clone());
        Ok(credential)
    }
}

static STATE: Mutex<CredentialState> = Mutex::new(CredentialState {
    updating: false,
    cached: None,
});
static GENERATION: AtomicU64 = AtomicU64::new(0);

pub(crate) fn updating(value: bool) {
    let mut state = STATE.lock();
    state.set_updating(value);
    if value {
        GENERATION.fetch_add(1, Ordering::AcqRel);
    }
    drop(state);
}

pub(crate) fn is_updating() -> bool {
    STATE.lock().updating
}
pub(crate) fn generation() -> u64 {
    GENERATION.load(Ordering::Acquire)
}

/// # Safety
/// The callback and context follow NativeCredential::read's synchronous contract.
pub(crate) unsafe fn read(
    reader: Option<ReadCredential>,
    context: *mut c_void,
) -> Result<(NativeCredential, u64), CredentialError> {
    let mut state = STATE.lock();
    // SAFETY: The native caller supplies a synchronous reader and live context.
    let key = unsafe { state.read(reader, context) }?;
    let generation = generation();
    drop(state);
    Ok((key, generation))
}

/// Warm the shared native cache without returning secret bytes to the platform.
///
/// # Safety
/// The callback and context follow NativeCredential::read's synchronous contract.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn whip_voice_credentials_prepare(
    reader: Option<ReadCredential>,
    context: *mut c_void,
) -> bool {
    // SAFETY: The native caller provides a live synchronous reader/context.
    unsafe { read(reader, context) }.is_ok()
}

pub(crate) fn message(error: CredentialError) -> String {
    match error {
        CredentialError::Missing => "Save an OpenAI API key in speech settings.",
        CredentialError::Locked => "Unlock the device and Whip to use OpenAI speech.",
        _ => "Could not access the OpenAI API key. Open Whip and try again.",
    }
    .into()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Vault {
        key: Option<&'static [u8]>,
        reads: usize,
    }

    unsafe extern "C" fn vault_read(context: *mut c_void, out: *mut u8, capacity: usize) -> i32 {
        // SAFETY: Tests lend a live Vault for the synchronous call.
        let vault = unsafe { &mut *context.cast::<Vault>() };
        vault.reads += 1;
        let Some(key) = vault.key else {
            return CredentialError::Missing as i32;
        };
        assert!(key.len() <= capacity);
        // SAFETY: The caller lends capacity bytes and the fixture fits.
        unsafe { std::ptr::copy_nonoverlapping(key.as_ptr(), out, key.len()) };
        i32::try_from(key.len()).unwrap_or(CredentialError::Failed as i32)
    }

    fn read_vault(
        state: &mut CredentialState,
        vault: &mut Vault,
    ) -> Result<Vec<u8>, CredentialError> {
        // SAFETY: vault_read follows the synchronous contract and vault is live.
        unsafe { state.read(Some(vault_read), std::ptr::from_mut(vault).cast()) }
            .map(|key| key.authorization().to_vec())
    }

    #[test]
    fn warm_cache_serves_speech_without_another_vault_read() {
        let mut state = CredentialState::default();
        let mut vault = Vault {
            key: Some(b"sk-first"),
            reads: 0,
        };
        assert_eq!(
            read_vault(&mut state, &mut vault),
            Ok(b"Bearer sk-first".to_vec())
        );
        vault.key = None;
        // SAFETY: A warmed cache does not invoke a reader or use its context.
        let background = unsafe { state.read(None, std::ptr::null_mut()) };
        assert_eq!(
            background.map(|key| key.authorization().to_vec()),
            Ok(b"Bearer sk-first".to_vec())
        );
        assert_eq!(vault.reads, 1);
    }

    #[test]
    fn replacement_and_deletion_never_reuse_the_previous_cached_key() {
        let mut state = CredentialState::default();
        let mut vault = Vault {
            key: Some(b"sk-first"),
            reads: 0,
        };
        assert!(read_vault(&mut state, &mut vault).is_ok());
        state.set_updating(true);
        assert_eq!(
            read_vault(&mut state, &mut vault),
            Err(CredentialError::Unavailable)
        );
        assert_eq!(vault.reads, 1);
        vault.key = None;
        state.set_updating(false);
        assert_eq!(
            read_vault(&mut state, &mut vault),
            Err(CredentialError::Missing)
        );
        vault.key = Some(b"sk-replaced");
        assert_eq!(
            read_vault(&mut state, &mut vault),
            Ok(b"Bearer sk-replaced".to_vec())
        );
    }
}
