//! A completed generation can precede WebRTC playout by many seconds.
//! Assistant audio tokens represent 50 ms, with small special-token overhead:
//! https://developers.openai.com/api/docs/guides/voice-latency-cost?voice-api=realtime
//! Decoded concealment and tail silence must not stretch that speech estimate.
use oai_rt_rs::{ContentPart, Item, Response, ResponseStatus, Role};

const AUDIO_TOKENS_PER_SECOND: usize = 20;

pub(super) struct Audio<'a> {
    pub item: &'a str,
    pub index: u32,
    pub transcript: &'a str,
    pub samples: usize,
}

pub(super) fn estimate(response: &Response) -> Option<Audio<'_>> {
    if !matches!(
        response.status,
        ResponseStatus::Completed | ResponseStatus::Incomplete
    ) {
        return None;
    }
    let tokens = response
        .usage
        .as_ref()?
        .output_token_details
        .as_ref()?
        .audio_tokens?;
    let samples = usize::try_from(tokens)
        .ok()?
        .checked_mul(super::super::RATE / AUDIO_TOKENS_PER_SECOND)?;
    if samples == 0 {
        return None;
    }
    let mut audio = None;
    for item in response.output.as_ref()? {
        let Item::Message {
            id: Some(id),
            role: Role::Assistant,
            content,
            ..
        } = item
        else {
            continue;
        };
        for (index, part) in content.iter().enumerate() {
            if let ContentPart::Audio { transcript, .. }
            | ContentPart::OutputAudio { transcript, .. } = part
            {
                // Usage totals cover the whole response. Never assign that
                // total to one of several audio parts or messages.
                if audio.is_some() {
                    return None;
                }
                audio = Some(Audio {
                    item: id,
                    index: u32::try_from(index).ok()?,
                    transcript: transcript.as_deref()?,
                    samples,
                });
            }
        }
    }
    audio
}
