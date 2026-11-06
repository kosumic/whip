//! Cumulative provider duration, independent of pricing or persistence.
#[derive(Default)]
pub struct DurationUsage {
    pub seconds: f64,
    pub finalized: bool,
    pub observed: bool,
}
impl DurationUsage {
    pub fn observe(&mut self, seconds: f64, finalized: bool) -> Result<(), &'static str> {
        if !seconds.is_finite() || seconds < 0.0 {
            return Err("GPT-Live returned invalid duration usage.");
        }
        if self.finalized {
            return Ok(());
        }
        if finalized && seconds < self.seconds {
            return Err("GPT-Live final duration disagrees with earlier usage.");
        }
        self.seconds = self.seconds.max(seconds);
        self.observed = true;
        self.finalized = finalized;
        Ok(())
    }
}
