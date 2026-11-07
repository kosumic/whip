//! Single-shot camera contract. The foreground UI owns the preview and shutter.
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{BrowserError, ErrorCode, decode, invalid_result};

pub(super) const NAME: &str = "device.capture_photo";
const MAX_DIMENSION: u32 = 1600;
const MAX_BYTES: usize = 1024 * 1024;
const MAX_BASE64_CHARS: usize = MAX_BYTES.div_ceil(3) * 4;
const MIME_TYPE: &str = "image/jpeg";

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Facing {
    #[default]
    Back,
    Front,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Args {
    #[serde(default)]
    pub facing: Facing,
}

impl Args {
    pub(super) fn wire(&self) -> Value {
        json!({
            "facing": self.facing,
            "max_dimension": MAX_DIMENSION,
            "max_base64_chars": MAX_BASE64_CHARS,
        })
    }

    pub(super) fn result(&self, value: Value) -> Result<Value, BrowserError> {
        if value.to_string().len() > super::super::browser::model::MAX_IMAGE_RESULT {
            return Err(BrowserError::new(
                ErrorCode::ResultTooLarge,
                "Photo response too large",
            ));
        }
        let photo: Photo = decode(value)?;
        if photo.width == 0
            || photo.height == 0
            || photo.width > MAX_DIMENSION
            || photo.height > MAX_DIMENSION
            || photo.mime_type != MIME_TYPE
            || photo.image.len() > MAX_BASE64_CHARS
        {
            return Err(invalid_result());
        }
        let bytes = STANDARD
            .decode(&photo.image)
            .map_err(|_| invalid_result())?;
        if bytes.len() > MAX_BYTES
            || !bytes.starts_with(&[0xff, 0xd8, 0xff])
            || !bytes.ends_with(&[0xff, 0xd9])
        {
            return Err(invalid_result());
        }
        let metadata = json!({"kind": NAME, "value": {
            "width": photo.width, "height": photo.height,
            "mime_type": MIME_TYPE, "facing": self.facing,
        }});
        Ok(json!({"structuredContent": metadata, "content": [
            {"type": "image", "mimeType": MIME_TYPE, "data": photo.image},
            {"type": "text", "text": metadata.to_string()},
        ]}))
    }
}

#[derive(Deserialize)]
struct Photo {
    width: u32,
    height: u32,
    mime_type: String,
    image: String,
}

pub(super) fn tool() -> Value {
    json!({
        "name": NAME,
        "description": "Open a foreground camera preview in Whip and return one photo the user takes with the shutter button. Optional facing: back (default) or front. Requests OS camera permission if needed. The user can cancel; backgrounding, session closure and the three-minute deadline cancel the capture. Returns a JPEG image plus dimensions and facing, at most 1600 pixels per side and 1 MiB. No gallery access or Shizuku is required; the temporary photo is deleted after capture.",
        "inputSchema": {"type": "object", "properties": {
            "facing": {"type": "string", "enum": ["back", "front"], "default": "back"},
        }, "additionalProperties": false},
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn photo() -> Value {
        json!({"width": 1280, "height": 960, "mime_type": MIME_TYPE,
            "image": STANDARD.encode([0xff, 0xd8, 0xff, 0xd9]),
            "uri": "file:///private/photo.jpg", "exif": {"GPSLatitude": 45}})
    }

    #[test]
    fn photo_returns_an_mcp_image_and_only_public_metadata()
    -> Result<(), Box<dyn std::error::Error>> {
        let action = Args {
            facing: Facing::Front,
        };
        let native = photo();
        let result = action.result(native.clone())?;
        assert_eq!(
            result["content"][0],
            json!({
                "type": "image", "mimeType": MIME_TYPE, "data": native["image"],
            })
        );
        let metadata = json!({"kind": NAME, "value": {
            "width": 1280, "height": 960, "mime_type": MIME_TYPE, "facing": "front",
        }});
        assert_eq!(result["structuredContent"], metadata);
        assert_eq!(result["content"][1]["text"], metadata.to_string());
        Ok(())
    }

    #[test]
    fn photo_rejects_invalid_images_dimensions_and_oversized_results() {
        for (field, value) in [
            ("width", json!(0)),
            ("height", json!(MAX_DIMENSION + 1)),
            ("mime_type", json!("image/png")),
            ("image", json!("not-base64")),
            ("image", json!(STANDARD.encode(b"not a JPEG"))),
            ("image", json!("a".repeat(MAX_BASE64_CHARS + 1))),
        ] {
            let mut native = photo();
            native[field] = value;
            assert!(Args::default().result(native).is_err(), "accepted {field}");
        }
    }
}
