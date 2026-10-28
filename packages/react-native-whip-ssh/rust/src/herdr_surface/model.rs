//! Bounded Endpoint generation 1 cell decoder. Wire order follows Herdr 2713feb.
use std::{collections::BTreeMap, ops::Range};

use serde::Serialize;

use crate::herdr_codec::{CodecError, Decoder};

pub(super) const MAX_CELLS: usize = 262_144;
const MAX_DIMENSION: u16 = 1024;
const MAX_SYMBOL_BYTES: usize = 4096;
const MAX_LINKS: usize = 4096;

fn invalid(name: &'static str) -> CodecError {
    CodecError::InvalidValue(name)
}

pub(super) fn count(d: &mut Decoder<'_>, max: usize) -> Result<usize, CodecError> {
    let value = usize::try_from(d.unsigned()?).map_err(|_| invalid("surface length"))?;
    if value > max {
        return Err(invalid("surface length limit"));
    }
    Ok(value)
}

pub(super) fn dimensions(width: u16, height: u16) -> Result<usize, CodecError> {
    let size = usize::from(width) * usize::from(height);
    if width == 0
        || height == 0
        || width > MAX_DIMENSION
        || height > MAX_DIMENSION
        || size > MAX_CELLS
    {
        return Err(invalid("surface dimensions"));
    }
    Ok(size)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(super) struct Cell {
    pub symbol: String,
    pub fg: u32,
    pub bg: u32,
    pub modifier: u16,
    pub skip: bool,
    pub hyperlink: Option<u32>,
}

fn cells(d: &mut Decoder<'_>) -> Result<Vec<Cell>, CodecError> {
    let size = count(d, MAX_CELLS)?;
    let mut cells = Vec::with_capacity(size);
    for _ in 0..size {
        cells.push(Cell {
            symbol: d.strict_string(MAX_SYMBOL_BYTES)?,
            fg: d.u32("foreground")?,
            bg: d.u32("background")?,
            modifier: d.u16("modifier")?,
            skip: d.boolean()?,
            hyperlink: if d.boolean()? {
                Some(d.u32("hyperlink")?)
            } else {
                None
            },
        });
    }
    Ok(cells)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(super) struct Cursor {
    pub x: u16,
    pub y: u16,
    pub visible: bool,
    pub shape: u8,
}
fn cursor(d: &mut Decoder<'_>) -> Result<Option<Cursor>, CodecError> {
    if !d.boolean()? {
        return Ok(None);
    }
    let value = Cursor {
        x: d.u16("cursor x")?,
        y: d.u16("cursor y")?,
        visible: d.boolean()?,
        shape: d.byte("cursor shape")?,
    };
    if value.shape > 6 {
        return Err(invalid("cursor shape"));
    }
    Ok(Some(value))
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Rect {
    x: u16,
    y: u16,
    width: u16,
    height: u16,
}
fn rect(d: &mut Decoder<'_>) -> Result<Rect, CodecError> {
    Ok(Rect {
        x: d.u16("rect x")?,
        y: d.u16("rect y")?,
        width: d.u16("rect width")?,
        height: d.u16("rect height")?,
    })
}
impl Rect {
    fn fits(&self, width: u16, height: u16) -> bool {
        self.width > 0
            && self.height > 0
            && u32::from(self.x) + u32::from(self.width) <= u32::from(width)
            && u32::from(self.y) + u32::from(self.height) <= u32::from(height)
    }
    fn contains(&self, x: u16, y: u16, len: usize) -> bool {
        x >= self.x
            && y >= self.y
            && u32::from(y) < u32::from(self.y) + u32::from(self.height)
            && usize::from(x) + len <= usize::from(self.x) + usize::from(self.width)
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Pane {
    id: String,
    rect: Rect,
    inner: Rect,
    scrollbar: Option<Rect>,
    focused: bool,
    pixels: (u32, u32),
}
fn panes(d: &mut Decoder<'_>) -> Result<Vec<Pane>, CodecError> {
    let size = count(d, 1)?; // This prototype deliberately refuses multi-pane surfaces.
    let mut panes = Vec::with_capacity(size);
    for _ in 0..size {
        let id = d.strict_string(256)?;
        let _content_revision = d.unsigned()?;
        let rect = rect(d)?;
        let inner = self::rect(d)?;
        let scrollbar = if d.boolean()? {
            Some(self::rect(d)?)
        } else {
            None
        };
        if d.boolean()? {
            d.unsigned()?;
            d.unsigned()?;
            d.unsigned()?;
        }
        let focused = d.boolean()?;
        d.boolean()?;
        d.boolean()?;
        d.boolean()?;
        let pixels = (d.u32("pane pixel width")?, d.u32("pane pixel height")?);
        panes.push(Pane {
            id,
            rect,
            inner,
            scrollbar,
            focused,
            pixels,
        });
    }
    Ok(panes)
}

impl Pane {
    fn same_geometry(&self, other: &Self) -> bool {
        self.id == other.id
            && self.rect == other.rect
            && self.inner == other.inner
            && self.focused == other.focused
            && self.pixels == other.pixels
    }
    fn contains_row(&self, old: &Self, row: &Row) -> bool {
        self.inner.contains(row.x, row.y, row.cells.len())
            || self
                .scrollbar
                .as_ref()
                .or(old.scrollbar.as_ref())
                .is_some_and(|r| {
                    row.x == r.x
                        && row.cells.len() == usize::from(r.width)
                        && r.contains(row.x, row.y, row.cells.len())
                })
    }
}

#[derive(Clone, Debug)]
pub(super) struct Full {
    boot: String,
    projection: u64,
    revision: u64,
    cells: Vec<Cell>,
    width: u16,
    height: u16,
    cursor: Option<Cursor>,
    links: Vec<String>,
    panes: Vec<Pane>,
}
#[derive(Clone, Debug)]
pub(super) struct Row {
    x: u16,
    y: u16,
    cells: Vec<Cell>,
}
#[derive(Clone, Debug)]
pub(super) struct Patch {
    boot: String,
    projection: u64,
    base: u64,
    revision: u64,
    rows: Vec<Row>,
    panes: Vec<Pane>,
    cursor: Option<Cursor>,
}

pub(super) enum SurfaceMessage {
    Full(Full),
    Patch(Patch),
    Other,
}
pub(super) fn decode(bytes: &[u8]) -> Result<SurfaceMessage, CodecError> {
    let mut d = Decoder::new(bytes);
    let tag = d.unsigned()?;
    if tag != 13 && tag != 19 {
        return Ok(SurfaceMessage::Other);
    }
    let boot = d.strict_string(256)?;
    let projection = d.unsigned()?;
    let first_revision = d.unsigned()?;
    let message = if tag == 13 {
        let cells = cells(&mut d)?;
        let width = d.u16("surface width")?;
        let height = d.u16("surface height")?;
        if dimensions(width, height)? != cells.len() {
            return Err(invalid("surface cell count"));
        }
        let cursor = cursor(&mut d)?;
        let mut links = Vec::new();
        for _ in 0..count(&mut d, MAX_LINKS)? {
            links.push(d.strict_string(8192)?);
        }
        // Graphics are a later milestone; fail explicitly rather than misparse or draw incorrectly.
        if count(&mut d, 0)? != 0 {
            return Err(invalid("graphics unsupported"));
        }
        let panes = panes(&mut d)?;
        count(&mut d, 0)?; // splits
        if d.boolean()? {
            return Err(invalid("popup surfaces unsupported"));
        }
        count(&mut d, 0)?;
        count(&mut d, 0)?;
        count(&mut d, 0)?; // graphics scene
        SurfaceMessage::Full(Full {
            boot,
            projection,
            revision: first_revision,
            cells,
            width,
            height,
            cursor,
            links,
            panes,
        })
    } else {
        let revision = d.unsigned()?;
        let mut rows = Vec::new();
        let mut total = 0;
        for _ in 0..count(&mut d, MAX_CELLS)? {
            let x = d.u16("patch x")?;
            let y = d.u16("patch y")?;
            let cells = cells(&mut d)?;
            total += cells.len();
            if total > MAX_CELLS {
                return Err(invalid("patch cell limit"));
            }
            rows.push(Row { x, y, cells });
        }
        SurfaceMessage::Patch(Patch {
            boot,
            projection,
            base: first_revision,
            revision,
            rows,
            panes: panes(&mut d)?,
            cursor: cursor(&mut d)?,
        })
    };
    if !d.exhausted() {
        return Err(invalid("surface trailing bytes"));
    }
    Ok(message)
}

fn valid_cursor(cursor: &Option<Cursor>, width: u16, height: u16) -> bool {
    cursor.as_ref().is_none_or(|c| c.x < width && c.y < height)
}
fn valid_links(cells: &[Cell], links: &[String]) -> bool {
    cells.iter().all(|c| {
        c.hyperlink
            .is_none_or(|index| (index as usize) < links.len())
    })
}

#[derive(Default)]
pub(super) struct Screen {
    full: Option<Full>,
    dirty: BTreeMap<u16, Range<usize>>,
    reset: bool,
    pending: bool,
}
#[derive(Serialize)]
pub(super) struct Update<'a> {
    pub width: u16,
    pub height: u16,
    pub revision: u64,
    pub reset: bool,
    pub cursor: &'a Option<Cursor>,
    pub hyperlinks: &'a [String],
    /// Row, first column, cells. Spans include adjacent glyphs for overhang and wide cells.
    pub rows: Vec<(u16, usize, &'a [Cell])>,
}

fn expand_damage(cells: &[Cell], mut range: Range<usize>) -> Range<usize> {
    range.start = range.start.saturating_sub(1);
    range.end = (range.end + 1).min(cells.len());
    while range.start > 0 && (cells[range.start].skip || cells[range.start].symbol.is_empty()) {
        range.start -= 1;
    }
    while range.end < cells.len() && (cells[range.end].skip || cells[range.end].symbol.is_empty()) {
        range.end += 1;
    }
    range
}

fn merge_damage(dirty: &mut BTreeMap<u16, Range<usize>>, y: u16, range: Range<usize>) {
    dirty
        .entry(y)
        .and_modify(|old| {
            old.start = old.start.min(range.start);
            old.end = old.end.max(range.end);
        })
        .or_insert(range);
}

impl Screen {
    pub fn apply(
        &mut self,
        message: SurfaceMessage,
        pane_id: &str,
        boot: &str,
        projection: u64,
    ) -> Result<(), CodecError> {
        match message {
            SurfaceMessage::Full(full) => {
                if full.boot != boot
                    || full.projection != projection
                    || full.revision == 0
                    || !valid_cursor(&full.cursor, full.width, full.height)
                    || !valid_links(&full.cells, &full.links)
                    || full.panes.len() != 1
                    || full.panes[0].id != pane_id
                    || !full.panes[0].focused
                    || !full.panes[0].rect.fits(full.width, full.height)
                    || !full.panes[0].inner.fits(full.width, full.height)
                    || full.panes[0]
                        .scrollbar
                        .as_ref()
                        .is_some_and(|r| !r.fits(full.width, full.height))
                    || self
                        .full
                        .as_ref()
                        .is_some_and(|old| old.boot == full.boot && old.revision >= full.revision)
                {
                    return Err(invalid("surface identity, geometry or revision"));
                }
                if let Some(old) = self.full.as_ref().filter(|old| {
                    old.boot == full.boot
                        && old.projection == full.projection
                        && old.width == full.width
                        && old.height == full.height
                }) {
                    let width = usize::from(full.width);
                    for (y, (before, after)) in old
                        .cells
                        .chunks_exact(width)
                        .zip(full.cells.chunks_exact(width))
                        .enumerate()
                    {
                        if let Some(start) = before.iter().zip(after).position(|(a, b)| a != b) {
                            let end =
                                before.iter().zip(after).rposition(|(a, b)| a != b).unwrap() + 1;
                            let a = expand_damage(before, start..end);
                            let b = expand_damage(after, start..end);
                            merge_damage(
                                &mut self.dirty,
                                y as u16,
                                a.start.min(b.start)..a.end.max(b.end),
                            );
                        }
                    }
                    self.pending |= old.cursor != full.cursor || old.links != full.links;
                } else {
                    self.dirty.clear();
                    self.dirty
                        .extend((0..full.height).map(|y| (y, 0..usize::from(full.width))));
                    self.reset = true;
                }
                self.full = Some(full);
            }
            SurfaceMessage::Patch(patch) => {
                let full = self
                    .full
                    .as_mut()
                    .ok_or(invalid("patch without full surface"))?;
                if patch.boot != boot
                    || patch.projection != projection
                    || patch.boot != full.boot
                    || patch.projection != full.projection
                    || patch.base != full.revision
                    || Some(patch.revision) != full.revision.checked_add(1)
                    || !valid_cursor(&patch.cursor, full.width, full.height)
                    || patch.panes.iter().any(|p| {
                        !p.same_geometry(&full.panes[0])
                            || p.scrollbar
                                .as_ref()
                                .is_some_and(|r| !r.fits(full.width, full.height))
                    })
                    || patch.rows.iter().any(|r| {
                        r.cells.is_empty()
                            || usize::from(r.x) + r.cells.len() > usize::from(full.width)
                            || r.y >= full.height
                            || !(if patch.panes.is_empty() {
                                full.panes[0].contains_row(&full.panes[0], r)
                            } else {
                                patch
                                    .panes
                                    .iter()
                                    .any(|p| p.contains_row(&full.panes[0], r))
                            })
                            || !valid_links(&r.cells, &full.links)
                    })
                {
                    return Err(invalid("surface patch revision or bounds"));
                }
                // All checks finish before any mutation. Invalid patches cannot leave a partial grid.
                for row in patch.rows {
                    let width = usize::from(full.width);
                    let row_start = usize::from(row.y) * width;
                    let cells = &mut full.cells[row_start..row_start + width];
                    let x = usize::from(row.x);
                    let before = &cells[x..x + row.cells.len()];
                    if let Some(start) = before.iter().zip(&row.cells).position(|(a, b)| a != b) {
                        let end = before
                            .iter()
                            .zip(&row.cells)
                            .rposition(|(a, b)| a != b)
                            .unwrap()
                            + 1;
                        let old = expand_damage(cells, x + start..x + end);
                        cells[x..x + row.cells.len()].clone_from_slice(&row.cells);
                        let new = expand_damage(cells, x + start..x + end);
                        merge_damage(
                            &mut self.dirty,
                            row.y,
                            old.start.min(new.start)..old.end.max(new.end),
                        );
                    }
                }
                self.pending |= full.cursor != patch.cursor;
                full.revision = patch.revision;
                full.cursor = patch.cursor;
                for pane in patch.panes {
                    full.panes[0] = pane;
                }
            }
            SurfaceMessage::Other => return Ok(()),
        }
        self.pending |= !self.dirty.is_empty();
        Ok(())
    }
    pub fn take(&mut self) -> Result<Option<String>, serde_json::Error> {
        if !self.pending {
            return Ok(None);
        }
        let Some(full) = self.full.as_ref() else {
            return Ok(None);
        };
        let rows = self
            .dirty
            .iter()
            .map(|(&y, range)| {
                let start = usize::from(y) * usize::from(full.width);
                (
                    y,
                    range.start,
                    &full.cells[start + range.start..start + range.end],
                )
            })
            .collect();
        let update = serde_json::to_string(&Update {
            width: full.width,
            height: full.height,
            revision: full.revision,
            reset: self.reset,
            cursor: &full.cursor,
            hyperlinks: &full.links,
            rows,
        })?;
        self.dirty.clear();
        self.reset = false;
        self.pending = false;
        Ok(Some(update))
    }
}
