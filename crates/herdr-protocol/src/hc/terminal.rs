//! Terminal attach and viewer facts, independent of a renderer or transport.
use super::{
    Error,
    generated::{Display, Request, TerminalAttachParams},
    wire::Kind,
};
#[derive(Clone, Copy, Debug)]
pub struct Geometry {
    pub columns: u16,
    pub rows: u16,
    pub cell: [u32; 2],
}
impl Geometry {
    pub fn new(columns: u32, rows: u32, cell: [u32; 2]) -> Result<Self, Error> {
        let columns = u16::try_from(columns)
            .ok()
            .filter(|n| *n > 0)
            .ok_or_else(|| Error::InvalidMessage("terminal columns must be 1..65535".into()))?;
        let rows = u16::try_from(rows)
            .ok()
            .filter(|n| *n > 0)
            .ok_or_else(|| Error::InvalidMessage("terminal rows must be 1..65535".into()))?;
        Ok(Self {
            columns,
            rows,
            cell,
        })
    }
    pub fn display(self) -> Display {
        Display {
            cell: (self.cell[0] > 0 && self.cell[1] > 0).then_some(self.cell),
            bg: None,
            fg: None,
            cursor: None,
            extra: std::collections::BTreeMap::default(),
        }
    }
    pub fn attach(self, terminal: String, resumed: bool) -> Request {
        Request::terminal_attach(TerminalAttachParams {
            terminal,
            cols: self.columns,
            rows: self.rows,
            display: Some(self.display()),
            resumed: Some(resumed),
            ..Default::default()
        })
    }
    pub fn updates(self) -> Result<[(Kind, Vec<u8>); 2], Error> {
        let mut resize = self.columns.to_le_bytes().to_vec();
        resize.extend(self.rows.to_le_bytes());
        Ok([
            (Kind::Resize, resize),
            (Kind::Facts, serde_json::to_vec(&self.display())?),
        ])
    }
}
