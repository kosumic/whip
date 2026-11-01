//! Lossless, optimistic edits of the desktop-owned `herdr-app` document.
use super::{
    Error,
    events::DocumentKey,
    projection::{PaneLocation, SpaceLocation, TabLocation},
};
use serde_json::{Value, json};

#[derive(Clone, Debug)]
pub struct Edit {
    pub key: DocumentKey,
    pub change: Change,
}
#[derive(Clone, Debug)]
pub enum Change {
    AddSpace {
        id: String,
        name: String,
        tab: Value,
    },
    RenameSpace {
        space: SpaceLocation,
        name: String,
    },
    RemoveSpace {
        space: SpaceLocation,
    },
    AddTab {
        space: SpaceLocation,
        tab: Value,
    },
    RenameTab {
        tab: TabLocation,
        name: String,
    },
    RemoveTab {
        tab: TabLocation,
    },
    RenamePane {
        pane: PaneLocation,
        name: Option<String>,
    },
    ReplaceTerminal {
        pane: PaneLocation,
        address: String,
    },
    Split {
        pane: PaneLocation,
        container: String,
        new_node: Value,
        row: bool,
    },
    RemovePane {
        pane: PaneLocation,
    },
}
impl Edit {
    pub fn key(&self) -> &DocumentKey {
        &self.key
    }
    pub fn apply(&self, base: &Value) -> Result<Value, Error> {
        let mut value = if base.is_null() {
            json!({"spaces":[]})
        } else {
            base.clone()
        };
        let spaces = value
            .get_mut("spaces")
            .and_then(Value::as_array_mut)
            .ok_or(Error::Unsupported("editing this desktop document shape"))?;
        match &self.change {
            Change::AddSpace { id, name, tab } => {
                if spaces
                    .iter()
                    .any(|s| s.get("id").and_then(Value::as_str) == Some(id))
                {
                    return Err(Error::DocumentConflict);
                }
                spaces.push(json!({"id":id,"name":name,"tabs":[tab]}));
            }
            Change::RenameSpace { space, name } => {
                space_mut(spaces, space)?
                    .as_object_mut()
                    .ok_or(Error::DocumentConflict)?
                    .insert("name".into(), json!(name));
            }
            Change::RemoveSpace { space } => {
                let i = space_index(spaces, space)?;
                spaces.remove(i);
            }
            Change::AddTab { space, tab } => {
                let tabs = tabs_mut(space_mut(spaces, space)?)?;
                let id = tab
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or(Error::DocumentConflict)?;
                if tabs
                    .iter()
                    .any(|t| t.get("id").and_then(Value::as_str) == Some(id))
                {
                    return Err(Error::DocumentConflict);
                }
                tabs.push(tab.clone());
            }
            Change::RenameTab { tab, name } => {
                tab_mut(spaces, tab)?
                    .as_object_mut()
                    .ok_or(Error::DocumentConflict)?
                    .insert("name".into(), json!(name));
            }
            Change::RemoveTab { tab } => {
                tab_mut(spaces, tab)?;
                let tabs = tabs_mut(space_mut(spaces, &tab.space)?)?;
                let i = unique_index(tabs, &tab.tab)?;
                tabs.remove(i);
            }
            Change::RenamePane { pane, name } => {
                let node = pane_mut(spaces, pane)?;
                let object = node.as_object_mut().ok_or(Error::DocumentConflict)?;
                match name {
                    Some(name) => {
                        object.insert("title".into(), json!(name));
                    }
                    None => {
                        object.remove("title");
                    }
                }
            }
            Change::ReplaceTerminal { pane, address } => {
                let node = pane_mut(spaces, pane)?;
                let terminal = node
                    .pointer_mut("/content/terminal")
                    .ok_or(Error::DocumentConflict)?;
                if terminal.as_str() != Some(relative_address(&pane.terminal, &pane.tab.space.key)?)
                {
                    return Err(Error::DocumentConflict);
                }
                *terminal = json!(relative_address(address, &pane.tab.space.key)?);
            }
            Change::Split {
                pane,
                container,
                new_node,
                row,
            } => {
                let root = tab_mut(spaces, &pane.tab)?
                    .get_mut("root")
                    .ok_or(Error::NotFound("layout root"))?;
                validate_nodes(root, &pane.node)?;
                if node_count(root, container, 0)? != 0 {
                    return Err(Error::DocumentConflict);
                }
                let node = find_node_mut(root, &pane.node, 0)?.ok_or(Error::NotFound("pane"))?;
                let mut old = node.take();
                // The old node retains its content and all unknown fields. Only
                // its placement sizing moves to the new container.
                let mut wrapper =
                    json!({"id":container,"type":if *row {"row"} else {"column"},"children":[]});
                for field in ["size", "min", "max"] {
                    if let Some(value) = old.as_object_mut().and_then(|o| o.remove(field)) {
                        wrapper
                            .as_object_mut()
                            .ok_or(Error::DocumentConflict)?
                            .insert(field.into(), value);
                    }
                }
                wrapper["children"] = json!([old, new_node]);
                *node = wrapper;
            }
            Change::RemovePane { pane } => {
                let tab = tab_mut(spaces, &pane.tab)?;
                let root = tab.get_mut("root").ok_or(Error::NotFound("layout root"))?;
                validate_nodes(root, &pane.node)?;
                if root.get("id").and_then(Value::as_str) == Some(&pane.node) {
                    // Keep the root's layout/appearance fields while removing
                    // only the explicitly closed terminal block.
                    let object = root.as_object_mut().ok_or(Error::DocumentConflict)?;
                    object.remove("content");
                    object.insert("type".into(), json!("stack"));
                    object.insert("children".into(), json!([]));
                } else if !remove_child(root, &pane.node, 0)? {
                    return Err(Error::NotFound("pane"));
                }
            }
        }
        if serde_json::to_vec(&value)?.len() > super::documents::MAX_DOCUMENT_BYTES {
            return Err(Error::Limit("desktop document bytes"));
        }
        Ok(value)
    }
}

pub fn terminal_node(id: &str, address: &str) -> Value {
    json!({"id":id,"type":"block","content":{"terminal":address}})
}
pub fn terminal_tab(id: &str, name: &str, node: &str, address: &str) -> Value {
    json!({"id":id,"name":name,"root":terminal_node(node,address)})
}
pub fn relative_address<'a>(address: &'a str, key: &DocumentKey) -> Result<&'a str, Error> {
    match &key.machine {
        None => Ok(address),
        Some(machine) => address
            .strip_prefix(&format!("{machine}/"))
            .ok_or(Error::InvalidMessage(
                "terminal does not belong to the document's core".into(),
            )),
    }
}
fn unique_index(values: &[Value], id: &str) -> Result<usize, Error> {
    let mut matches = values
        .iter()
        .enumerate()
        .filter(|(_, v)| v.get("id").and_then(Value::as_str) == Some(id));
    let index = matches
        .next()
        .map(|(i, _)| i)
        .ok_or(Error::NotFound("desktop item"))?;
    if matches.next().is_some() {
        return Err(Error::DocumentConflict);
    }
    Ok(index)
}
fn space_index(spaces: &mut Vec<Value>, location: &SpaceLocation) -> Result<usize, Error> {
    if location.virtual_space
        && !spaces
            .iter()
            .any(|s| s.get("id").and_then(Value::as_str) == Some(&location.space))
    {
        spaces.push(json!({"id":location.space,"name":"Terminals","tabs":[]}));
    }
    unique_index(spaces, &location.space)
}
fn space_mut<'a>(
    spaces: &'a mut Vec<Value>,
    location: &SpaceLocation,
) -> Result<&'a mut Value, Error> {
    let i = space_index(spaces, location)?;
    Ok(&mut spaces[i])
}
fn tabs_mut(space: &mut Value) -> Result<&mut Vec<Value>, Error> {
    space
        .get_mut("tabs")
        .and_then(Value::as_array_mut)
        .ok_or(Error::Unsupported("editing this desktop space shape"))
}
fn tab_mut<'a>(spaces: &'a mut Vec<Value>, location: &TabLocation) -> Result<&'a mut Value, Error> {
    let tabs = tabs_mut(space_mut(spaces, &location.space)?)?;
    if location.virtual_tab
        && !tabs
            .iter()
            .any(|t| t.get("id").and_then(Value::as_str) == Some(&location.tab))
    {
        let terminal = location
            .tab
            .strip_prefix("terminal:")
            .ok_or(Error::DocumentConflict)?;
        let address = relative_address(terminal, &location.space.key)?;
        tabs.push(terminal_tab(&location.tab, address, &location.tab, address));
    }
    let i = unique_index(tabs, &location.tab)?;
    Ok(&mut tabs[i])
}
fn pane_mut<'a>(
    spaces: &'a mut Vec<Value>,
    location: &PaneLocation,
) -> Result<&'a mut Value, Error> {
    let root = tab_mut(spaces, &location.tab)?
        .get_mut("root")
        .ok_or(Error::NotFound("layout root"))?;
    validate_nodes(root, &location.node)?;
    find_node_mut(root, &location.node, 0)?.ok_or(Error::NotFound("pane"))
}
fn node_count(node: &Value, id: &str, depth: usize) -> Result<usize, Error> {
    if depth > 64 {
        return Err(Error::Limit("desktop layout depth"));
    }
    let mut count = usize::from(node.get("id").and_then(Value::as_str) == Some(id));
    for field in ["children", "floating"] {
        if let Some(children) = node.get(field).and_then(Value::as_array) {
            for child in children {
                count += node_count(child, id, depth + 1)?;
            }
        }
    }
    Ok(count)
}
fn validate_nodes(root: &Value, id: &str) -> Result<(), Error> {
    match node_count(root, id, 0)? {
        0 => Err(Error::NotFound("pane")),
        1 => Ok(()),
        _ => Err(Error::DocumentConflict),
    }
}
fn find_node_mut<'a>(
    node: &'a mut Value,
    id: &str,
    depth: usize,
) -> Result<Option<&'a mut Value>, Error> {
    if depth > 64 {
        return Err(Error::Limit("desktop layout depth"));
    }
    if node.get("id").and_then(Value::as_str) == Some(id) {
        return Ok(Some(node));
    }
    // Search immutably to select a branch before borrowing it mutably.
    for field in ["children", "floating"] {
        let index = node
            .get(field)
            .and_then(Value::as_array)
            .and_then(|children| {
                children
                    .iter()
                    .position(|c| node_count(c, id, depth + 1).is_ok_and(|n| n > 0))
            });
        if let Some(index) = index {
            return find_node_mut(&mut node[field][index], id, depth + 1);
        }
    }
    Ok(None)
}
fn remove_child(node: &mut Value, id: &str, depth: usize) -> Result<bool, Error> {
    if depth > 64 {
        return Err(Error::Limit("desktop layout depth"));
    }
    for field in ["children", "floating"] {
        if let Some(children) = node.get_mut(field).and_then(Value::as_array_mut) {
            if let Some(index) = children
                .iter()
                .position(|c| c.get("id").and_then(Value::as_str) == Some(id))
            {
                children.remove(index);
                return Ok(true);
            }
            for child in children {
                if remove_child(child, id, depth + 1)? {
                    return Ok(true);
                }
            }
        }
    }
    Ok(false)
}
