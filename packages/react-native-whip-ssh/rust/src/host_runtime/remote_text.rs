//! Lazy, bounded UTF-8 text paging over SFTP. Only page cursors grow with a file.

use std::collections::{BTreeMap, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use super::{
    AsyncMutex, HostRuntime, HostRuntimeError, RuntimeInner, current_generation, current_ssh,
    resolved_remote_path, validate_generation,
};
use crate::ssh::SftpMetadata;

const READ_PAGE_BYTES: u64 = 256 * 1024;
const ROW_BYTES: usize = 2048;
const PAGE_ROWS: u16 = 64;
const CACHE_PAGES: usize = 8;
const CACHE_BLOCKS: usize = 8;
const UTF8_LOOKAHEAD: usize = 4;

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct RemoteTextAnchor {
    pub page_index: u64,
    pub byte_offset: u64,
    pub line_number: u64,
    pub continued: bool,
}

impl Default for RemoteTextAnchor {
    fn default() -> Self {
        Self {
            page_index: 0,
            byte_offset: 0,
            line_number: 1,
            continued: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct RemoteTextRow {
    pub line_number: u64,
    pub continued: bool,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct RemoteTextPage {
    pub row_capacity: u32,
    pub anchor: RemoteTextAnchor,
    pub next: RemoteTextAnchor,
    pub rows: Vec<RemoteTextRow>,
    pub eof: bool,
}

struct Block {
    offset: u64,
    bytes: Vec<u8>,
}

struct ReaderState {
    cursors: BTreeMap<u64, RemoteTextAnchor>,
    blocks: VecDeque<Block>,
    pages: VecDeque<RemoteTextPage>,
}

#[derive(uniffi::Object)]
pub struct RemoteTextReader {
    inner: Arc<RuntimeInner>,
    generation: u64,
    path: String,
    size: u64,
    modified_at: Option<u64>,
    state: AsyncMutex<ReaderState>,
    closed: AtomicBool,
}

fn failure(message: impl Into<String>) -> HostRuntimeError {
    HostRuntimeError::RemoteFileFailure(message.into())
}

fn matching_file(metadata: &SftpMetadata, size: u64, modified_at: Option<u64>) -> bool {
    metadata.is_regular && metadata.size == Some(size) && metadata.modified_at == modified_at
}

/// Decode one bounded display segment. A UTF-8 character may straddle the row
/// budget or a source block, but is never split or replaced with U+FFFD.
fn decode_row(
    cursor: &mut RemoteTextAnchor,
    bytes: &[u8],
    eof: bool,
) -> Result<RemoteTextRow, HostRuntimeError> {
    let text = match std::str::from_utf8(bytes) {
        Ok(text) => text,
        Err(error) if error.error_len().is_none() && !eof => {
            std::str::from_utf8(&bytes[..error.valid_up_to()])
                .map_err(|_| failure("remote file is not valid UTF-8 text"))?
        }
        Err(_) => return Err(failure("remote file is not valid UTF-8 text")),
    };
    let mut end = text.len().min(ROW_BYTES);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    let newline = text[..end].find('\n');
    if let Some(newline) = newline {
        end = newline + 1;
    } else if end > 1
        && text.as_bytes()[end - 1] == b'\r'
        && text.as_bytes().get(end) == Some(&b'\n')
    {
        end -= 1;
    }
    if end == 0 && !bytes.is_empty() {
        return Err(failure("remote file is not valid UTF-8 text"));
    }
    let content = &text[..end];
    let display = if newline.is_some() {
        let line = content.strip_suffix('\n').unwrap_or(content);
        line.strip_suffix('\r').unwrap_or(line)
    } else {
        content
    };
    let row = RemoteTextRow {
        line_number: cursor.line_number,
        continued: cursor.continued,
        text: display.to_owned(),
    };
    cursor.byte_offset += end as u64;
    cursor.continued = newline.is_none();
    if newline.is_some() {
        cursor.line_number += 1;
    }
    Ok(row)
}

#[uniffi::export]
impl HostRuntime {
    pub async fn open_remote_text_reader(
        &self,
        path: String,
        expected_size: u64,
        expected_modified_at: Option<u64>,
        anchor: Option<RemoteTextAnchor>,
    ) -> Result<Arc<RemoteTextReader>, HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                let generation = current_generation(&inner)?;
                let path = resolved_remote_path(&inner, Some(&path)).await?;
                let metadata = current_ssh(&inner)?.sftp_stat(&path).await?;
                validate_generation(&inner, generation)?;
                if !matching_file(&metadata, expected_size, expected_modified_at) {
                    return Err(failure(
                        "remote file changed; reopen it to continue reading",
                    ));
                }
                let mut cursors = BTreeMap::from([(0, RemoteTextAnchor::default())]);
                if let Some(anchor) = anchor {
                    if anchor.byte_offset > expected_size
                        || anchor.line_number == 0
                        || anchor.line_number > anchor.byte_offset.saturating_add(1)
                        || anchor.page_index > anchor.byte_offset / u64::from(PAGE_ROWS)
                        || (expected_size > 0 && anchor.byte_offset == expected_size)
                        || (anchor.page_index == 0 && anchor != RemoteTextAnchor::default())
                    {
                        return Err(failure("invalid remote text reading position"));
                    }
                    cursors.insert(anchor.page_index, anchor);
                }
                Ok(Arc::new(RemoteTextReader {
                    inner,
                    generation,
                    path,
                    size: expected_size,
                    modified_at: expected_modified_at,
                    state: AsyncMutex::new(ReaderState {
                        cursors,
                        blocks: VecDeque::new(),
                        pages: VecDeque::new(),
                    }),
                    closed: AtomicBool::new(false),
                }))
            })
            .await
            .map_err(|error| failure(format!("remote text open task failed: {error}")))?
    }
}

impl RemoteTextReader {
    fn validate(&self) -> Result<(), HostRuntimeError> {
        if self.closed.load(Ordering::Acquire) {
            return Err(failure("remote text reader is closed"));
        }
        validate_generation(&self.inner, self.generation)
    }

    async fn bytes_at(
        &self,
        state: &mut ReaderState,
        offset: u64,
    ) -> Result<Vec<u8>, HostRuntimeError> {
        let end = offset
            .saturating_add((ROW_BYTES + UTF8_LOOKAHEAD) as u64)
            .min(self.size);
        let mut bytes = Vec::with_capacity(ROW_BYTES + UTF8_LOOKAHEAD);
        let mut position = offset;
        while position < end {
            self.validate()?;
            let block_offset = position / READ_PAGE_BYTES * READ_PAGE_BYTES;
            let block = if let Some(index) = state
                .blocks
                .iter()
                .position(|block| block.offset == block_offset)
            {
                state
                    .blocks
                    .remove(index)
                    .ok_or_else(|| failure("missing text block"))?
            } else {
                let (metadata, bytes) = current_ssh(&self.inner)?
                    .sftp_read_range(&self.path, block_offset, READ_PAGE_BYTES)
                    .await?;
                self.validate()?;
                if !matching_file(&metadata, self.size, self.modified_at)
                    || bytes.len() as u64 != READ_PAGE_BYTES.min(self.size - block_offset)
                {
                    return Err(failure(
                        "remote file changed; reopen it to continue reading",
                    ));
                }
                Block {
                    offset: block_offset,
                    bytes,
                }
            };
            let start = usize::try_from(position - block_offset)
                .map_err(|_| failure("invalid text block offset"))?;
            let count = usize::try_from(end - position)
                .map_err(|_| failure("invalid text block length"))?
                .min(block.bytes.len() - start);
            let newline = block.bytes[start..start + count]
                .iter()
                .take(ROW_BYTES.saturating_sub(bytes.len()))
                .position(|byte| *byte == b'\n');
            let count = newline.map_or(count, |newline| newline + 1);
            bytes.extend_from_slice(&block.bytes[start..start + count]);
            position += count as u64;
            state.blocks.push_back(block);
            if state.blocks.len() > CACHE_BLOCKS {
                state.blocks.pop_front();
            }
            if newline.is_some() {
                break;
            }
        }
        Ok(bytes)
    }

    async fn page(&self, index: u64) -> Result<RemoteTextPage, HostRuntimeError> {
        self.validate()?;
        let mut state = self.state.lock().await;
        self.validate()?;
        if let Some(position) = state
            .pages
            .iter()
            .position(|page| page.anchor.page_index == index)
        {
            let page = state
                .pages
                .remove(position)
                .ok_or_else(|| failure("missing text page"))?;
            state.pages.push_back(page.clone());
            drop(state);
            return Ok(page);
        }
        let mut cursor = state
            .cursors
            .range(..=index)
            .next_back()
            .map(|(_, cursor)| cursor.clone())
            .ok_or_else(|| failure("missing text cursor"))?;
        if cursor.byte_offset == self.size && index > 0 {
            return Err(failure("text page is past the end of the file"));
        }
        loop {
            self.validate()?;
            let anchor = cursor.clone();
            let mut rows = Vec::with_capacity(usize::from(PAGE_ROWS));
            while rows.len() < usize::from(PAGE_ROWS) && cursor.byte_offset < self.size {
                let bytes = self.bytes_at(&mut state, cursor.byte_offset).await?;
                let eof = cursor.byte_offset + bytes.len() as u64 == self.size;
                rows.push(decode_row(&mut cursor, &bytes, eof)?);
            }
            if rows.is_empty() && cursor.byte_offset == 0 {
                rows.push(RemoteTextRow {
                    line_number: 1,
                    continued: false,
                    text: String::new(),
                });
            }
            let eof = cursor.byte_offset == self.size;
            cursor.page_index += 1;
            let page = RemoteTextPage {
                row_capacity: u32::from(PAGE_ROWS),
                anchor,
                next: cursor.clone(),
                rows,
                eof,
            };
            state.cursors.insert(cursor.page_index, cursor.clone());
            state.pages.push_back(page.clone());
            if state.pages.len() > CACHE_PAGES {
                state.pages.pop_front();
            }
            if page.anchor.page_index == index {
                drop(state);
                return Ok(page);
            }
            if eof {
                drop(state);
                return Err(failure("text page is past the end of the file"));
            }
        }
    }
}

#[uniffi::export]
impl RemoteTextReader {
    pub async fn read_page(
        self: Arc<Self>,
        index: u64,
    ) -> Result<RemoteTextPage, HostRuntimeError> {
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move { self.page(index).await })
            .await
            .map_err(|error| failure(format!("remote text page task failed: {error}")))?
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
        if let Ok(mut state) = self.state.try_lock() {
            state.pages.clear();
            state.blocks.clear();
            state.cursors.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn rows_preserve_utf8_crlf_and_long_line_continuations() {
        let mut cursor = RemoteTextAnchor::default();
        let first = decode_row(&mut cursor, "日本語 😀\r\nnext".as_bytes(), true).unwrap();
        assert_eq!(first.text, "日本語 😀");
        assert_eq!(cursor.line_number, 2);
        let long = "語".repeat(ROW_BYTES);
        let first = decode_row(&mut cursor, long.as_bytes(), false).unwrap();
        assert!(!first.continued);
        assert!(first.text.len() <= ROW_BYTES);
        let next = decode_row(&mut cursor, b"end\n", true).unwrap();
        assert!(next.continued);
        assert_eq!(next.line_number, 2);
        assert_eq!(cursor.line_number, 3);
    }

    #[test]
    fn incomplete_lookahead_is_allowed_but_invalid_or_truncated_utf8_is_rejected() {
        let mut cursor = RemoteTextAnchor::default();
        assert_eq!(
            decode_row(&mut cursor, b"ok\n\xe6", false).unwrap().text,
            "ok"
        );
        for bytes in [
            b"bad\xff".as_slice(),
            b"truncated\xe6".as_slice(),
            b"\xc0\x80".as_slice(),
        ] {
            assert!(decode_row(&mut cursor, bytes, true).is_err());
        }
    }

    #[test]
    fn utf8_segments_round_trip_across_row_and_source_block_boundaries() {
        let source = format!(
            "{}語 😀\r\n{}\nlast\r",
            "a".repeat(usize::try_from(READ_PAGE_BYTES).unwrap() - 1),
            "文".repeat(3000)
        );
        let mut cursor = RemoteTextAnchor::default();
        let mut reconstructed = String::new();
        while cursor.byte_offset < source.len() as u64 {
            let start = usize::try_from(cursor.byte_offset).unwrap();
            let end = source.len().min(start + ROW_BYTES + UTF8_LOOKAHEAD);
            let previous_line = cursor.line_number;
            let row = decode_row(
                &mut cursor,
                &source.as_bytes()[start..end],
                end == source.len(),
            )
            .unwrap();
            reconstructed.push_str(&row.text);
            if cursor.line_number != previous_line {
                reconstructed.push('\n');
            }
        }
        assert_eq!(reconstructed, source.replace("\r\n", "\n"));
    }

    #[test]
    fn large_files_open_without_reading_the_tail_and_resume_without_scanning_the_prefix()
    -> Result<(), Box<dyn std::error::Error>> {
        use super::super::tests::connected_runtime_inner;
        use std::io::{Seek, Write};

        crate::runtime()?.block_on(async {
            let directory = tempfile::tempdir()?;
            let path = directory.path().join("notes");
            let size = 10 * 1024 * 1024_u64;
            let mut file = std::fs::File::create(&path)?;
            file.write_all(&b"first\n".repeat(usize::from(PAGE_ROWS)))?;
            file.set_len(size)?;
            // Corrupt the far tail: opening the beginning must not fetch it.
            file.seek(std::io::SeekFrom::Start(size - 1))?;
            file.write_all(&[0xff])?;
            let fixture = crate::ssh::ReverseForwardFixture::new(true, Duration::ZERO).await?;
            let inner = connected_runtime_inner("paged-text-test");
            inner.herdr.install(1, fixture.ssh.clone());
            let runtime = HostRuntime {
                inner: inner.clone(),
            };
            let path = path.to_string_lossy().into_owned();
            let metadata = runtime.stat_remote_path(path.clone()).await?;
            let reader = runtime
                .open_remote_text_reader(path.clone(), size, metadata.modified_at, None)
                .await?;
            let page = reader.clone().read_page(0).await?;
            assert_eq!(page.rows.len(), usize::from(PAGE_ROWS));
            assert!(page.rows.iter().all(|row| row.text == "first"));
            assert!(!page.eof);
            assert_eq!(fixture.sftp_bytes_read() as u64, READ_PAGE_BYTES);
            assert_eq!(
                page.next.byte_offset,
                (b"first\n".len() * usize::from(PAGE_ROWS)) as u64
            );
            {
                let state = reader.state.lock().await;
                assert_eq!(state.blocks.len(), 1);
                assert_eq!(state.blocks[0].bytes.len() as u64, READ_PAGE_BYTES);
            }
            assert_eq!(reader.clone().read_page(0).await?, page);
            assert_eq!(fixture.sftp_bytes_read() as u64, READ_PAGE_BYTES);
            reader.close();
            assert!(reader.read_page(0).await.is_err());

            let anchor = RemoteTextAnchor {
                page_index: 1000,
                byte_offset: 4 * 1024 * 1024,
                line_number: 65,
                continued: true,
            };
            let resumed = runtime
                .open_remote_text_reader(
                    path.clone(),
                    size,
                    metadata.modified_at,
                    Some(anchor.clone()),
                )
                .await?;
            let page = resumed.clone().read_page(anchor.page_index).await?;
            assert_eq!(page.anchor, anchor);
            {
                let state = resumed.state.lock().await;
                assert!(state.cursors.len() <= 3);
                assert!(
                    state
                        .blocks
                        .iter()
                        .all(|block| block.offset >= anchor.byte_offset)
                );
                assert!(state.blocks.len() <= CACHE_BLOCKS);
                drop(state);
            }
            for index in 1001..=1020 {
                resumed.clone().read_page(index).await?;
            }
            {
                let state = resumed.state.lock().await;
                assert_eq!(state.pages.len(), CACHE_PAGES);
                assert_eq!(state.blocks.len(), CACHE_BLOCKS);
                drop(state);
            }
            let tail = RemoteTextAnchor {
                byte_offset: size - 16,
                ..anchor
            };
            let invalid = runtime
                .open_remote_text_reader(path.clone(), size, metadata.modified_at, Some(tail))
                .await?;
            assert!(invalid.read_page(1000).await.is_err());

            // File replacement and SSH replacement both invalidate the reader.
            file.set_len(size + 1)?;
            assert!(resumed.clone().read_page(1021).await.is_err());
            inner
                .state
                .lock()
                .begin_reconnect(Some(1), "test reconnect");
            assert!(resumed.read_page(1020).await.is_err());
            Ok(())
        })
    }
}
