//! OS execution expiry must cancel SFTP even when the React executor is suspended.
use std::ffi::{CStr, c_char};

/// # Safety
/// The native callers supply NUL-terminated UTF-8 strings for the duration of this call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn whip_cancel_background_download(
    runtime_id: *const c_char,
    transfer_id: *const c_char,
) {
    if runtime_id.is_null() || transfer_id.is_null() {
        return;
    }
    // SAFETY: Both platform adapters pass live, NUL-terminated strings.
    let (Ok(runtime_id), Ok(transfer_id)) = (
        unsafe { CStr::from_ptr(runtime_id) }.to_str(),
        unsafe { CStr::from_ptr(transfer_id) }.to_str(),
    ) else {
        return;
    };
    let runtime = super::runtimes().read().get(runtime_id).cloned();
    if let Some(runtime) = runtime {
        runtime.operations.cancel_transfer(transfer_id);
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "test assertions")]
    use std::ffi::CString;

    use super::whip_cancel_background_download;
    use crate::host_runtime::{runtimes, tests::connected_runtime_inner};

    #[test]
    fn os_expiration_cancels_only_the_bound_host_and_transfer() {
        let first = connected_runtime_inner("os-expiry-first");
        let second = connected_runtime_inner("os-expiry-second");
        let (id, cancelled, _) = first.operations.begin_transfer(1).unwrap();
        let (_, other_first, _) = first.operations.begin_transfer(1).unwrap();
        let (_, other_host, _) = second.operations.begin_transfer(1).unwrap();
        runtimes().write().insert(first.id.clone(), first.clone());
        runtimes().write().insert(second.id.clone(), second.clone());
        let host = CString::new(first.id.as_str()).unwrap();
        let transfer = CString::new(id).unwrap();
        // SAFETY: The owned strings remain live through the native callback.
        unsafe { whip_cancel_background_download(host.as_ptr(), transfer.as_ptr()) };
        runtimes().write().remove(&first.id);
        runtimes().write().remove(&second.id);
        assert!(*cancelled.borrow());
        assert!(!*other_first.borrow());
        assert!(!*other_host.borrow());
    }
}
