use super::*;
use std::collections::VecDeque;
use std::future::ready;

fn snapshot() -> TerminalSelectionSnapshot {
    TerminalSelectionSnapshot {
        columns: 12,
        text: "efghijkl\nmnop\nnext".into(),
        rows: vec!["abcdefghijkl".into(), "mnop".into(), "next".into()],
        start_row: 0,
        start_column: 4,
        end_row: 2,
        end_column: 4,
        offset_from_bottom: Some(5),
    }
}

fn responses(text: &str) -> VecDeque<Value> {
    VecDeque::from([
        json!({"type":"pane_info","pane":{"pane_id":"p1","terminal_id":"t1","scroll":{"viewport_rows":3,"offset_from_bottom":5,"max_offset_from_bottom":30}}}),
        json!({"type":"pane_selection","pane_id":"p1","text":text}),
    ])
}

#[tokio::test]
async fn copies_authoritative_text_with_scrollback_and_inclusive_cell_endpoints() {
    // The server's wrap metadata determines the newline after "mnop" even
    // though the preceding selected row fills the viewport width.
    let expected = "efghijklmnop\nnext";
    let mut responses = responses(expected);
    let mut requests = Vec::new();
    let text = read_selection_using("t1", "p1", snapshot(), |method, params| {
        requests.push((method, params));
        ready(Ok(responses.pop_front().unwrap()))
    })
    .await
    .unwrap();
    assert_eq!(text, expected);
    assert_eq!(requests[0].0, "pane.get");
    assert_eq!(
        requests[1],
        (
            "pane.selection.read",
            json!({
                "pane_id":"p1", "anchor":{"row":25,"col":4},
                "cursor":{"row":27,"col":3},
            })
        )
    );
    assert_eq!(requests.len(), 2);
}

#[test]
fn converts_exclusive_next_row_endpoint_without_copying_an_extra_cell() {
    let mut selection = snapshot();
    selection.end_row = 1;
    selection.end_column = 0;
    assert_eq!(
        selection.range().unwrap(),
        (TextPoint { row: 0, col: 4 }, TextPoint { row: 0, col: 11 },)
    );
    selection.start_row = 0;
    selection.start_column = 12;
    selection.end_row = 2;
    assert_eq!(
        selection.range().unwrap(),
        (TextPoint { row: 1, col: 0 }, TextPoint { row: 1, col: 11 },)
    );
}

#[tokio::test]
async fn rejects_changed_selected_characters() {
    let mut responses = responses("wrong text");
    let result = read_selection_using("t1", "p1", snapshot(), |_, _| {
        ready(Ok(responses.pop_front().unwrap()))
    })
    .await;
    assert!(matches!(
        result,
        Err(HerdrControlError::RequestCancelled(_))
    ));
    assert!(responses.is_empty());
}

#[tokio::test]
async fn unrelated_repaints_do_not_require_the_whole_pane_to_remain_unchanged() {
    let mut selection = snapshot();
    selection.rows.push("old spinner".into());
    let expected = "efghijklmnop\nnext";
    let mut replies = responses(expected);
    replies[0]["pane"]["scroll"]["viewport_rows"] = json!(4);
    let text = read_selection_using("t1", "p1", selection, |method, params| {
        // Only selected cells need to agree. A pane-wide read or revision
        // would fail while this unselected spinner continues to animate.
        assert!(matches!(method, "pane.get" | "pane.selection.read"));
        assert!(params.get("content_revision").is_none());
        ready(Ok(replies.pop_front().unwrap()))
    })
    .await
    .unwrap();
    assert_eq!(text, expected);
}

#[tokio::test]
async fn repaint_padding_does_not_replace_the_servers_original_whitespace() {
    let mut selection = snapshot();
    selection.text = "efghijkl    \nmnop    \nnext    ".into();
    let expected = "  efghijklmnop\n\tnext";
    let mut replies = responses(expected);
    let text = read_selection_using("t1", "p1", selection, |_, _| {
        ready(Ok(replies.pop_front().unwrap()))
    })
    .await
    .unwrap();
    assert_eq!(text, expected);
}

#[tokio::test]
async fn rejects_a_changed_scroll_offset_or_terminal_identity() {
    for wrong in [
        json!({"offset_from_bottom":6}),
        json!({"terminal_id":"other"}),
    ] {
        let mut replies = responses("wrong text");
        let pane = replies[0]["pane"].as_object_mut().unwrap();
        if let Some(offset) = wrong.get("offset_from_bottom") {
            pane.get_mut("scroll").unwrap()["offset_from_bottom"] = offset.clone();
        } else {
            pane.insert("terminal_id".into(), wrong["terminal_id"].clone());
        }
        let result = read_selection_using("t1", "p1", snapshot(), |_, _| {
            ready(Ok(replies.pop_front().unwrap()))
        })
        .await;
        assert!(matches!(
            result,
            Err(HerdrControlError::RequestCancelled(_))
        ));
        assert_eq!(replies.len(), 1);
    }
}

#[tokio::test]
async fn propagates_selection_api_errors_to_the_copy_fallback() {
    let mut replies = responses("unused");
    let result = read_selection_using("t1", "p1", snapshot(), |method, _| {
        ready(if method == "pane.selection.read" {
            Err(HerdrControlError::ProtocolError(
                "selection_unavailable".into(),
                "selection text is unavailable".into(),
            ))
        } else {
            Ok(replies.pop_front().unwrap())
        })
    })
    .await;
    assert!(
        matches!(result, Err(HerdrControlError::ProtocolError(code, _)) if code == "selection_unavailable")
    );
}

#[tokio::test]
async fn rejects_empty_reversed_and_out_of_viewport_ranges_before_network_requests() {
    for (row, column) in [(0, 4), (0, 3), (3, 1), (1, 13)] {
        let mut selection = snapshot();
        selection.end_row = row;
        selection.end_column = column;
        let requests = std::cell::Cell::new(0);
        let result = read_selection_using("t1", "p1", selection, |_, _| {
            requests.set(requests.get() + 1);
            ready(Err(cancelled()))
        })
        .await;
        assert!(result.is_err());
        assert_eq!(requests.get(), 0);
    }
}
