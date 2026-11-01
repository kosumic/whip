//! Lossless, versioned herdr-app documents. View focus and zoom are caller-local.
use super::{
    Error,
    events::DocumentKey,
    generated::{DocGetResult, DocSetParams},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub const APP_DOCUMENT: &str = "herdr-app";
pub const MAX_DOCUMENT_BYTES: usize = 1024 * 1024;
pub const MAX_DOCUMENTS: usize = 128;
pub const MAX_TOTAL_DOCUMENT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Document {
    pub value: Value,
    pub version: u64,
}

impl Document {
    pub fn from_reply(reply: DocGetResult) -> Result<Self, Error> {
        let document = Self {
            value: reply.value,
            version: reply.version,
        };
        document.validate()?;
        Ok(document)
    }
    pub fn validate(&self) -> Result<(), Error> {
        if serde_json::to_vec(&self.value)?.len() > MAX_DOCUMENT_BYTES {
            return Err(Error::Limit("document JSON"));
        }
        Ok(())
    }
    pub fn write(&self, key: &DocumentKey, value: Value) -> Result<DocSetParams, Error> {
        Self {
            value: value.clone(),
            version: self.version,
        }
        .validate()?;
        Ok(DocSetParams {
            name: key.name.clone(),
            on: key.machine.clone(),
            value,
            version: self.version,
        })
    }
}

#[derive(Clone, Debug, Default)]
pub struct Documents {
    values: BTreeMap<DocumentKey, Document>,
    dirty: BTreeMap<DocumentKey, u64>,
}

impl Documents {
    pub fn get(&self, key: &DocumentKey) -> Option<&Document> {
        self.values.get(key)
    }
    pub fn values(&self) -> impl Iterator<Item = (&DocumentKey, &Document)> {
        self.values.iter()
    }
    pub fn dirty(&self) -> impl Iterator<Item = &DocumentKey> {
        self.dirty.keys()
    }
    pub fn invalidate(&mut self, key: DocumentKey, minimum_version: u64) -> Result<(), Error> {
        if self.values.len()
            + self
                .dirty
                .keys()
                .filter(|key| !self.values.contains_key(*key))
                .count()
            >= MAX_DOCUMENTS
            && !self.values.contains_key(&key)
            && !self.dirty.contains_key(&key)
        {
            return Err(Error::Limit("watched documents"));
        }
        self.dirty
            .entry(key)
            .and_modify(|v| *v = (*v).max(minimum_version))
            .or_insert(minimum_version);
        Ok(())
    }
    pub fn invalidate_all(&mut self) {
        for (key, document) in &self.values {
            self.dirty
                .entry(key.clone())
                .and_modify(|v| *v = (*v).max(document.version))
                .or_insert(document.version);
        }
    }
    /// Late reads and write acknowledgements cannot replace a newer document.
    pub fn apply(&mut self, key: DocumentKey, document: Document) -> Result<bool, Error> {
        document.validate()?;
        if self
            .values
            .get(&key)
            .is_some_and(|old| old.version > document.version)
        {
            return Ok(false);
        }
        let dirty_version = self.dirty.get(&key).copied().unwrap_or(0);
        if document.version < dirty_version {
            return Ok(false);
        }
        if !self.values.contains_key(&key) && self.values.len() >= MAX_DOCUMENTS {
            return Err(Error::Limit("watched documents"));
        }
        let mut bytes = serde_json::to_vec(&document.value)?.len();
        for (other, value) in &self.values {
            if other != &key {
                bytes = bytes.saturating_add(serde_json::to_vec(&value.value)?.len());
            }
        }
        if bytes > MAX_TOTAL_DOCUMENT_BYTES {
            return Err(Error::Limit("total document JSON"));
        }
        self.values.insert(key.clone(), document);
        self.dirty.remove(&key);
        Ok(true)
    }
    pub fn forget_machine(&mut self, machine: &str) {
        self.values
            .retain(|key, _| key.machine.as_deref() != Some(machine));
        self.dirty
            .retain(|key, _| key.machine.as_deref() != Some(machine));
    }
    pub fn acknowledge(
        &mut self,
        key: DocumentKey,
        base: &Document,
        value: Value,
        version: u64,
    ) -> Result<bool, Error> {
        if base.version.checked_add(1) != Some(version) {
            return Err(Error::InvalidMessage(
                "document acknowledgement has an invalid version".into(),
            ));
        }
        self.apply(key, Document { value, version })
    }
}
