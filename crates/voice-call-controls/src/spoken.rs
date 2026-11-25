use super::{INVALID_DURATION, Request};

impl Request {
    /// Client-delegated Live calls supply captions instead of function arguments.
    /// Match a whole request so discussion of the microphone stays ordinary speech.
    pub fn from_spoken(text: &str) -> Option<Result<Self, &'static str>> {
        let text = text
            .trim()
            .trim_end_matches(['.', '?', '!'])
            .to_ascii_lowercase();
        let words: Vec<_> = text
            .split_whitespace()
            .map(|word| word.trim_end_matches(','))
            .collect();
        let mut command = words.as_slice();
        if let Some(rest) = command
            .strip_prefix(&["no", "i", "mean"])
            .or_else(|| command.strip_prefix(&["i", "mean"]))
        {
            command = rest;
        }
        command = command
            .strip_prefix(&["can", "you"])
            .or_else(|| command.strip_prefix(&["could", "you"]))
            .unwrap_or(command);
        command = command.strip_prefix(&["please"]).unwrap_or(command);
        command = command.strip_suffix(&["please"]).unwrap_or(command);
        let (verb, object) = command.split_first()?;
        let muted = match *verb {
            "mute" => true,
            "unmute" => false,
            _ => return None,
        };
        let tail = match object {
            ["my" | "the", "microphone" | "mic", tail @ ..] | ["me", tail @ ..] => tail,
            _ => return None,
        };
        let duration_minutes = match tail {
            [] => None,
            ["for", amount @ .., unit] if muted => {
                let minutes = match *unit {
                    "second" | "seconds" => 1.0 / 60.0,
                    "minute" | "minutes" => 1.0,
                    "hour" | "hours" => 60.0,
                    _ => return Some(Err(INVALID_DURATION)),
                };
                let Some(number) = spoken_number(amount) else {
                    return Some(Err(INVALID_DURATION));
                };
                Some(number * minutes)
            }
            ["for", ..] => return Some(Err(INVALID_DURATION)),
            _ => return None,
        };
        let request = Self {
            muted,
            duration_minutes,
        };
        Some(request.duration().map(|_| request))
    }
}

fn spoken_number(words: &[&str]) -> Option<f64> {
    const SMALL: [&str; 20] = [
        "zero",
        "one",
        "two",
        "three",
        "four",
        "five",
        "six",
        "seven",
        "eight",
        "nine",
        "ten",
        "eleven",
        "twelve",
        "thirteen",
        "fourteen",
        "fifteen",
        "sixteen",
        "seventeen",
        "eighteen",
        "nineteen",
    ];
    const TENS: [&str; 8] = [
        "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
    ];
    let number = words.join(" ").replace('-', " ");
    if let Ok(value) = number.parse() {
        return Some(value);
    }
    if matches!(number.as_str(), "a" | "an") {
        return Some(1.0);
    }
    if matches!(number.as_str(), "half a" | "half an") {
        return Some(0.5);
    }
    let index = |list: &[&str], word: &str| {
        list.iter()
            .position(|entry| *entry == word)
            .and_then(|i| u32::try_from(i).ok())
    };
    if let Some(small) = index(&SMALL, &number) {
        return Some(f64::from(small));
    }
    let (tens, ones) = number.split_once(' ').unwrap_or((&number, "zero"));
    Some(f64::from(
        (index(&TENS, tens)? + 2) * 10 + index(&SMALL[..10], ones)?,
    ))
}
