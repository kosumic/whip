/// A voice failure and its eligibility for recovery after confirmed cleanup.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Failure {
    pub message: &'static str,
    pub retryable: bool,
}
impl Failure {
    pub const fn transport(message: &'static str) -> Self {
        Self {
            message,
            retryable: true,
        }
    }
}
impl std::fmt::Display for Failure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message)
    }
}
impl std::error::Error for Failure {}
impl From<&'static str> for Failure {
    fn from(message: &'static str) -> Self {
        Self {
            message,
            retryable: false,
        }
    }
}
