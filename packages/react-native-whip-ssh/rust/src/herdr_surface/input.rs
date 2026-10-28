//! Convert the existing native keyboard's VT-shaped events into Endpoint semantic
//! events. Herdr, not Whip, encodes the child application's keyboard protocol.
use crate::herdr_codec::Encoder;

const SHIFT: u8 = 1;
// Endpoint v1 uses crossterm modifier bits, which differ from VT's modifier parameter.
const CTRL: u8 = 2;
const ALT: u8 = 4;
const VT_ALT: u8 = 2;
const VT_CTRL: u8 = 4;
const PANE_INPUT: u64 = 13;
const KEY: u64 = 0;
const TEXT: u64 = 1;
const PASTE: u64 = 3;

fn key(code: u64, ch: Option<char>, modifiers: u8) -> Vec<u8> {
    let mut e = Encoder::default();
    e.unsigned(KEY);
    e.unsigned(code);
    if let Some(ch) = ch {
        e.raw(ch.encode_utf8(&mut [0; 4]).as_bytes());
    }
    e.raw(&[modifiers]);
    e.unsigned(0); // Press
    e.unsigned(1); // repeat_count
    e.boolean(false);
    e.boolean(false);
    e.boolean(false);
    e.boolean(false);
    e.boolean(false);
    e.finish()
}
fn text_event(kind: u64, text: &str) -> Vec<u8> {
    let mut e = Encoder::default();
    e.unsigned(kind);
    e.byte_string(text.as_bytes());
    e.finish()
}
fn navigation(sequence: &str) -> Option<(u64, u8)> {
    let body = sequence
        .strip_prefix('[')
        .or_else(|| sequence.strip_prefix('O'))?;
    let last = body.chars().last()?;
    let params = &body[..body.len() - last.len_utf8()];
    let modifier = params
        .split(';')
        .nth(1)
        .unwrap_or("1")
        .parse::<u8>()
        .ok()?
        .checked_sub(1)?;
    if modifier > (SHIFT | ALT | CTRL) {
        return None;
    }
    let modifier = (modifier & SHIFT)
        | if modifier & VT_ALT != 0 { ALT } else { 0 }
        | if modifier & VT_CTRL != 0 { CTRL } else { 0 };
    let code = match last {
        'A' => 4,
        'B' => 5,
        'C' => 3,
        'D' => 2,
        'H' => 6,
        'F' => 7,
        'Z' => 11,
        '~' => match params.split(';').next()? {
            "1" | "7" => 6,
            "4" | "8" => 7,
            "5" => 8,
            "6" => 9,
            "3" => 12,
            "2" => 13,
            _ => return None,
        },
        _ => return None,
    };
    Some((
        code,
        if last == 'Z' {
            modifier | SHIFT
        } else {
            modifier
        },
    ))
}

pub(super) fn encode(pane: &str, text: &str, paste: bool) -> Result<Vec<u8>, String> {
    if text.len() > 131_072 {
        return Err("input exceeds prototype limit".into());
    }
    let mut events = Vec::new();
    if paste {
        events.push(text_event(PASTE, text));
    } else {
        let mut input = text.char_indices().peekable();
        let mut printable = String::new();
        while let Some((_, ch)) = input.next() {
            if !ch.is_control() && ch != '\u{7f}' {
                printable.push(ch);
                continue;
            }
            if !printable.is_empty() {
                events.push(text_event(TEXT, &printable));
                printable.clear();
            }
            match ch {
                '\r' | '\n' => events.push(key(1, None, 0)),
                '\u{8}' | '\u{7f}' => events.push(key(0, None, 0)),
                '\t' => events.push(key(10, None, 0)),
                '\u{1b}' => {
                    if input.peek().is_some_and(|(_, c)| *c == '[' || *c == 'O') {
                        let mut sequence = String::new();
                        while let Some((_, c)) = input.next() {
                            sequence.push(c);
                            if sequence.len() > 1 && (c.is_ascii_alphabetic() || c == '~') {
                                break;
                            }
                            if sequence.len() > 32 {
                                return Err("unsupported native keyboard sequence".into());
                            }
                        }
                        let (code, modifiers) =
                            navigation(&sequence).ok_or("unsupported native keyboard sequence")?;
                        events.push(key(code, None, modifiers));
                    } else if let Some((_, c)) = input.next() {
                        if c.is_control() {
                            return Err("unsupported Alt control combination".into());
                        }
                        events.push(key(15, Some(c), ALT));
                    } else {
                        events.push(key(14, None, 0));
                    }
                }
                '\0' => events.push(key(15, Some(' '), CTRL)),
                '\u{1}'..='\u{1a}' => {
                    events.push(key(15, char::from_u32(u32::from(ch) + 96), CTRL))
                }
                '\u{1c}'..='\u{1f}' => {
                    events.push(key(15, char::from_u32(u32::from(ch) + 64), CTRL))
                }
                _ => return Err("unsupported native input control".into()),
            }
        }
        if !printable.is_empty() {
            events.push(text_event(TEXT, &printable));
        }
    }
    let mut e = Encoder::default();
    e.unsigned(PANE_INPUT);
    e.byte_string(pane.as_bytes());
    e.unsigned(events.len() as u64);
    for event in events {
        e.raw(&event);
    }
    Ok(e.finish())
}
