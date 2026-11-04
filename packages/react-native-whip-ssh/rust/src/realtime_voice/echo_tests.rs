use super::*;

#[test]
fn silence_in_media_track_never_counts_as_heard_assistant_audio() -> Result<(), &'static str> {
    let mut clock = PlaybackClock::default();
    clock.submit(1, 240, false)?;
    clock.submit(1, 240, true)?;
    clock.submit(1, 240, false)?;
    assert_eq!(clock.played(1, 120), 0);
    assert_eq!(clock.played(1, 360), 120);
    assert_eq!(clock.played(1, 720), 240);
    assert_eq!(clock.played(1, 240), 240);
    clock.submit(2, 240, false)?;
    assert_eq!(clock.played(1, 720), 0);
    assert_eq!(clock.played(2, 240), 0);
    Ok(())
}
