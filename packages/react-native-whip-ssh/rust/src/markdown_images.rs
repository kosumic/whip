//! Bitmap thumbnails for SVG images embedded in native Markdown.

use std::sync::{Arc, OnceLock};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use resvg::{tiny_skia, usvg};

const MAX_SVG_BYTES: usize = 512 * 1024;
const MAX_IMAGE_DIMENSION: f32 = 2048.0;
static FONTS: OnceLock<Arc<usvg::fontdb::Database>> = OnceLock::new();

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum MarkdownImageError {
    #[error("SVG exceeds the Markdown image size limit")]
    TooLarge,
    #[error("Could not render Markdown SVG: {0}")]
    RenderFailed(String),
}

/// Returns a base64 PNG for the native Markdown renderer, which cannot decode SVG.
#[uniffi::export]
pub async fn render_markdown_svg(svg: String) -> Result<String, MarkdownImageError> {
    if svg.len() > MAX_SVG_BYTES {
        return Err(MarkdownImageError::TooLarge);
    }
    crate::runtime()
        .map_err(MarkdownImageError::RenderFailed)?
        .spawn_blocking(move || rasterize(&svg))
        .await
        .map_err(|error| MarkdownImageError::RenderFailed(error.to_string()))?
}

fn fonts() -> Arc<usvg::fontdb::Database> {
    Arc::clone(FONTS.get_or_init(|| {
        let mut db = usvg::fontdb::Database::new();
        // Use the app's fonts on both Android and iOS without scanning host files.
        for bytes in [
            include_bytes!("../../../../assets/gui-fonts/Inter-Regular.ttf").as_slice(),
            include_bytes!("../../../../assets/gui-fonts/Inter-Bold.ttf").as_slice(),
            include_bytes!("../../../../assets/terminal-fonts/JetBrainsMono-Regular.ttf")
                .as_slice(),
        ] {
            db.load_font_data(bytes.to_vec());
        }
        db.set_sans_serif_family("Inter");
        db.set_serif_family("Inter");
        db.set_monospace_family("JetBrains Mono");
        Arc::new(db)
    }))
}

fn rasterize(svg: &str) -> Result<String, MarkdownImageError> {
    let options = usvg::Options {
        font_family: "Inter".to_owned(),
        fontdb: fonts(),
        image_href_resolver: usvg::ImageHrefResolver {
            // Embedded images are supported, but a remote SVG cannot read local files.
            resolve_string: Box::new(|_, _| None),
            ..usvg::ImageHrefResolver::default()
        },
        ..usvg::Options::default()
    };
    let tree = usvg::Tree::from_str(svg, &options)
        .map_err(|error| MarkdownImageError::RenderFailed(error.to_string()))?;
    let size = tree.size();
    let scale = (MAX_IMAGE_DIMENSION / size.width().max(size.height())).min(1.0);
    let width = (size.width() * scale).round().max(1.0) as u32;
    let height = (size.height() * scale).round().max(1.0) as u32;
    let mut pixmap = tiny_skia::Pixmap::new(width, height)
        .ok_or_else(|| MarkdownImageError::RenderFailed("Invalid SVG dimensions".to_owned()))?;
    resvg::render(
        &tree,
        tiny_skia::Transform::from_scale(scale, scale),
        &mut pixmap.as_mut(),
    );
    let png = pixmap
        .encode_png()
        .map_err(|error| MarkdownImageError::RenderFailed(error.to_string()))?;
    Ok(STANDARD.encode(png))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn thumbnail(svg: &str) -> tiny_skia::Pixmap {
        let encoded = rasterize(svg).unwrap();
        tiny_skia::Pixmap::decode_png(&STANDARD.decode(encoded).unwrap()).unwrap()
    }

    #[test]
    fn renders_pixels_and_preserves_aspect_ratio_at_the_size_limit() {
        let image = thumbnail(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="4096" height="2048"><rect width="4096" height="2048" fill="red"/></svg>"#,
        );
        assert_eq!((image.width(), image.height()), (2048, 1024));
        assert_eq!(image.pixel(0, 0).unwrap().red(), 255);
        assert_eq!(image.pixel(0, 0).unwrap().alpha(), 255);
    }

    #[test]
    fn renders_text_using_the_bundled_fonts() {
        let image = thumbnail(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="120" height="30"><text x="2" y="22" font-size="20" font-family="sans-serif">Whip</text></svg>"#,
        );
        assert!(image.pixels().iter().any(|pixel| pixel.alpha() > 0));
    }

    #[test]
    fn ignores_file_references_including_in_embedded_svg() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("private.png");
        let mut secret = tiny_skia::Pixmap::new(10, 10).unwrap();
        secret.fill(tiny_skia::Color::from_rgba8(255, 0, 0, 255));
        secret.save_png(&path).unwrap();
        let svg = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="{}" width="10" height="10"/></svg>"#,
            path.display(),
        );
        let embedded = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="data:image/svg+xml;base64,{}" width="10" height="10"/></svg>"#,
            STANDARD.encode(&svg),
        );
        for source in [svg, embedded] {
            assert!(
                thumbnail(&source)
                    .pixels()
                    .iter()
                    .all(|pixel| pixel.alpha() == 0)
            );
        }
    }

    #[test]
    fn rejects_invalid_svg() {
        assert!(rasterize("<svg><rect></svg>").is_err());
    }
}
