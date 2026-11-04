//! Shared OpenAI credential ingress for speech and conversation adapters.
use native_credentials::{CredentialError, NativeCredential, ReadCredential};
use parking_lot::Mutex;
use std::ffi::c_void;
use std::sync::atomic::{AtomicU64, Ordering};

static UPDATING: Mutex<bool> = Mutex::new(false);
static GENERATION: AtomicU64 = AtomicU64::new(0);

pub(crate) fn updating(value: bool) {
    let mut updating = UPDATING.lock();
    *updating = value;
    if value {
        GENERATION.fetch_add(1, Ordering::AcqRel);
    }
    drop(updating);
}

pub(crate) fn is_updating() -> bool {
    *UPDATING.lock()
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
    let updating = UPDATING.lock();
    if *updating {
        return Err(CredentialError::Unavailable);
    }
    let reader = reader.ok_or(CredentialError::Unavailable)?;
    // SAFETY: The native caller supplies a synchronous reader and live context.
    let key = unsafe { NativeCredential::read(reader, context) }?;
    let generation = generation();
    drop(updating);
    Ok((key, generation))
}

pub(crate) fn message(error: CredentialError) -> String {
    match error {
        CredentialError::Missing => "Save an OpenAI API key in speech settings.",
        CredentialError::Locked => "Unlock the device and Whip to use OpenAI speech.",
        _ => "Could not access the OpenAI API key. Open Whip and try again.",
    }
    .into()
}
