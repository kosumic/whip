use super::*;
fn document(id: &str, text: &str) -> ChatSearchDocument {
    ChatSearchDocument {
        id: id.into(),
        text: text.into(),
        reveal: vec![id.into()],
    }
}

fn search(index: &mut SearchState, query: &str) -> ChatSearchResults {
    index.search(query.into())
}

#[test]
fn global_result_focus_reveals_a_document_beyond_the_normal_match_cap() {
    let mut index = SearchState::default();
    index.set_documents(vec![
        document("noisy-tool", &"needle ".repeat(MAX_MATCHES + 1)),
        document("message", "needle"),
    ]);
    let results = {
        index.search("needle".into());
        index.focus(ChatSearchFocus {
            document_id: "message".into(),
            offset: 0,
        })
    };
    assert!(results.truncated);
    assert_eq!(results.matches.len(), MAX_MATCHES);
    assert_eq!(
        results.matches[results.selected.unwrap() as usize].document_id,
        "message"
    );
    let stale = {
        index.search("needle".into());
        index.focus(ChatSearchFocus {
            document_id: "message".into(),
            offset: 999,
        })
    };
    assert_eq!(
        stale
            .matches
            .iter()
            .filter(|hit| hit.document_id == "message")
            .count(),
        1
    );
}

#[test]
fn finds_literal_case_insensitive_occurrences_and_wraps_both_ways() {
    let mut index = SearchState::default();
    index.set_documents(vec![
        document("prompt", "Fix a.b then A.B"),
        document("tool", "aXb a.b"),
    ]);
    let results = search(&mut index, "a.b");
    assert_eq!(results.matches.len(), 3);
    assert_eq!(results.matches[1].matched, "A.B");
    assert_eq!(index.navigate(true).selected, Some(2));
    assert_eq!(index.navigate(false).selected, Some(0));
    assert_eq!(index.select(2).selected, Some(2));
    assert_eq!(index.select(99).selected, Some(2));
    assert_eq!(search(&mut index, "   ").selected, None);
    assert!(index.navigate(true).matches.is_empty());
}

#[test]
fn unicode_lowercase_expansion_and_emoji_preserve_original_excerpts() {
    let mut index = SearchState::default();
    index.set_documents(vec![document("text", "😀 İSTANBUL — CAFÉ 中文 😀")]);
    let results = search(&mut index, "i");
    assert_eq!(results.matches[0].matched, "İ");
    assert_eq!(results.matches[0].before, "😀 ");
    assert_eq!(search(&mut index, "café").matches[0].matched, "CAFÉ");
    assert_eq!(search(&mut index, "中文").matches[0].matched, "中文");
    assert_eq!(search(&mut index, "😀").matches.len(), 2);
    index.set_documents(vec![document("greek", "ΟΣ")]);
    assert_eq!(search(&mut index, "ΟΣ").matches[0].matched, "ΟΣ");
}

#[test]
fn snapshot_updates_preserve_selection_and_remove_stale_matches() {
    let mut index = SearchState::default();
    index.set_documents(vec![document("a", "match"), document("b", "match")]);
    search(&mut index, "match");
    index.navigate(false);
    index.set_documents(vec![
        document("older", "match"),
        document("a", "match"),
        document("b", "match and more match"),
    ]);
    let results = search(&mut index, "match");
    assert_eq!(results.selected, Some(2));
    index.set_documents(vec![document("a", "replaced")]);
    assert!(search(&mut index, "match").matches.is_empty());
    assert_eq!(search(&mut index, "replaced").selected, Some(0));
}

#[test]
fn results_and_unicode_excerpts_are_bounded() {
    let mut index = SearchState::default();
    index.set_documents(vec![document("large", &"hit ".repeat(MAX_MATCHES + 1))]);
    let results = search(&mut index, "hit");
    assert_eq!(results.matches.len(), MAX_MATCHES);
    assert!(results.truncated);
    index.set_documents(vec![document(
        "unicode",
        &format!("{}needle{}", "😀".repeat(100), "界".repeat(100)),
    )]);
    let results = search(&mut index, "needle");
    let hit = &results.matches[0];
    assert_eq!(hit.before.chars().count(), CONTEXT_CHARS);
    assert_eq!(hit.after.chars().count(), CONTEXT_CHARS);
    assert!(hit.leading && hit.trailing);
}
