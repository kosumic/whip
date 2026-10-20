//! HTML5 parsing and Markdown generation for the native rich text renderer.

use html5ever::{ParseOpts, parse_document, tendril::TendrilSink};
use scraper::{ElementRef, Html, HtmlTreeSink};

const FRAGMENT_PREFIX: &str = "\u{e002}WHIP_HTML_CODE_";
const FRAGMENT_END: char = '\u{e003}';
const LINK_SCHEMES: &[&str] = &["http", "https", "mailto", "tel"];
const IMAGE_SCHEMES: &[&str] = &["http", "https"];

/// Generated links, images and code stay opaque until math normalization ends.
#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct RichTextHtml {
    pub content: String,
    pub fragment_prefix: String,
    pub protected_fragments: Vec<String>,
}

#[uniffi::export]
pub fn convert_rich_text_html(value: String) -> RichTextHtml {
    let document = parse_document(
        HtmlTreeSink::new(Html::new_document()),
        ParseOpts::default(),
    )
    .one(value.as_str());
    let mut result = RichTextHtml {
        content: String::new(),
        fragment_prefix: FRAGMENT_PREFIX.to_owned(),
        protected_fragments: Vec::new(),
    };
    // Literal input must not impersonate a protected fragment.
    while value.contains(&result.fragment_prefix) {
        result.fragment_prefix.push('_');
    }
    let rendered = result.render_element(document.root_element(), false);
    result.content = clean_markdown(&rendered);
    result
}

fn omitted_tag(tag: &str) -> bool {
    matches!(
        tag,
        "script" | "style" | "noscript" | "template" | "iframe" | "object" | "embed" | "head"
    )
}

fn block_tag(tag: &str) -> bool {
    matches!(
        tag,
        "p" | "div"
            | "article"
            | "aside"
            | "section"
            | "main"
            | "header"
            | "footer"
            | "figure"
            | "figcaption"
    )
}

fn compact_markdown(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clean_markdown(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for line in value.split('\n') {
        let line = line.trim_matches([' ', '\t']);
        if !line.is_empty() || !output.ends_with("\n\n") {
            output.push_str(line);
            output.push('\n');
        }
    }
    output.trim().to_owned()
}

fn escape_angles(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut backslashes = 0;
    for character in value.chars() {
        if character == '\\' {
            backslashes += 1;
            continue;
        }
        let angle = matches!(character, '<' | '>');
        output.extend(std::iter::repeat_n(
            '\\',
            backslashes * if angle { 2 } else { 1 },
        ));
        backslashes = 0;
        if angle {
            output.push('\\');
        }
        output.push(character);
    }
    output.extend(std::iter::repeat_n('\\', backslashes));
    output
}

fn escape_label(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for character in value.chars() {
        if matches!(character, '\\' | '[' | ']' | '<' | '>' | '|') {
            output.push('\\');
        }
        output.push(character);
    }
    output
}

fn safe_target(value: Option<&str>, schemes: &[&str]) -> Option<String> {
    let target = value?.trim();
    if target.is_empty() || target.chars().any(|character| character < ' ') {
        return None;
    }
    if let Some((scheme, _)) = target.split_once(':') {
        let mut characters = scheme.chars();
        let valid_scheme = characters
            .next()
            .is_some_and(|character| character.is_ascii_alphabetic())
            && characters.all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '+' | '.' | '-')
            });
        if valid_scheme
            && !schemes
                .iter()
                .any(|allowed| scheme.eq_ignore_ascii_case(allowed))
        {
            return None;
        }
    }
    let mut escaped = String::with_capacity(target.len());
    for character in target.chars() {
        escaped.push_str(match character {
            '\\' => "%5C",
            ' ' => "%20",
            '(' => "%28",
            ')' => "%29",
            '<' => "%3C",
            '>' => "%3E",
            _ => {
                escaped.push(character);
                continue;
            }
        });
    }
    Some(escaped)
}

fn child_elements(element: ElementRef<'_>) -> impl Iterator<Item = ElementRef<'_>> {
    element.children().filter_map(ElementRef::wrap)
}

fn text_content(element: ElementRef<'_>) -> String {
    if omitted_tag(element.value().name()) {
        return String::new();
    }
    if element.value().name() == "br" {
        return "\n".to_owned();
    }
    element
        .children()
        .map(|child| {
            if let Some(text) = child.value().as_text() {
                text.to_string()
            } else {
                ElementRef::wrap(child).map_or_else(String::new, text_content)
            }
        })
        .collect()
}

fn longest_backticks(value: &str) -> usize {
    value
        .split(|character| character != '`')
        .map(str::len)
        .max()
        .unwrap_or_default()
}

fn language_name(value: &str) -> bool {
    value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '+' | '-'))
}

fn table_rows<'a>(table: ElementRef<'a>, rows: &mut Vec<ElementRef<'a>>) {
    for child in child_elements(table) {
        match child.value().name() {
            "tr" => rows.push(child),
            "tbody" | "thead" | "tfoot" => table_rows(child, rows),
            _ => {}
        }
    }
}

impl RichTextHtml {
    fn protect(&mut self, markdown: String) -> String {
        let token = format!(
            "{}{}{FRAGMENT_END}",
            self.fragment_prefix,
            self.protected_fragments.len()
        );
        self.protected_fragments.push(markdown);
        token
    }

    fn render_children(&mut self, element: ElementRef<'_>, in_link: bool) -> String {
        element
            .children()
            .map(|child| {
                if let Some(text) = child.value().as_text() {
                    if in_link {
                        escape_label(text)
                    } else {
                        escape_angles(text)
                    }
                } else {
                    ElementRef::wrap(child)
                        .map_or_else(String::new, |element| self.render_element(element, in_link))
                }
            })
            .collect()
    }

    fn render_element(&mut self, element: ElementRef<'_>, in_link: bool) -> String {
        let tag = element.value().name();
        if omitted_tag(tag) {
            return String::new();
        }
        match tag {
            "pre" => self.render_code_block(element),
            "code" | "kbd" => {
                let text = text_content(element);
                let fence = "`".repeat(longest_backticks(&text) + 1);
                let padding = if text.starts_with('`') || text.ends_with('`') {
                    " "
                } else {
                    ""
                };
                self.protect(format!("{fence}{padding}{text}{padding}{fence}"))
            }
            "img" => {
                let label = escape_label(element.attr("alt").unwrap_or("Image"));
                self.protect(
                    safe_target(element.attr("src"), IMAGE_SCHEMES)
                        .map_or_else(|| label.clone(), |target| format!("![{label}]({target})")),
                )
            }
            "a" => {
                let label = compact_markdown(&self.render_children(element, true));
                self.protect(
                    safe_target(element.attr("href"), LINK_SCHEMES)
                        .map_or_else(|| label.clone(), |target| format!("[{label}]({target})")),
                )
            }
            "table" => self.render_table(element),
            "ul" | "ol" => self.render_list(element),
            "details" => self.render_details(element),
            "blockquote" => {
                let content = self.render_children(element, false);
                let content = content.trim();
                let quote = if content.is_empty() {
                    ">".to_owned()
                } else {
                    content
                        .lines()
                        .map(|line| format!("> {line}"))
                        .collect::<Vec<_>>()
                        .join("\n")
                };
                format!("\n\n{quote}\n\n")
            }
            "hr" => "\n\n---\n\n".to_owned(),
            "br" => "\n".to_owned(),
            _ => {
                let content = self.render_children(element, in_link);
                let marker = match tag {
                    "strong" | "b" => "**",
                    "em" | "i" => "*",
                    "del" | "s" => "~~",
                    _ => "",
                };
                if !marker.is_empty() {
                    if content.is_empty() {
                        content
                    } else {
                        format!("{marker}{content}{marker}")
                    }
                } else if matches!(tag, "h1" | "h2" | "h3" | "h4" | "h5" | "h6") {
                    format!(
                        "\n\n{} {}\n\n",
                        "#".repeat(usize::from(tag.as_bytes()[1] - b'0')),
                        compact_markdown(&content)
                    )
                } else if block_tag(tag) {
                    format!("{content}\n\n")
                } else {
                    content
                }
            }
        }
    }

    fn render_code_block(&mut self, element: ElementRef<'_>) -> String {
        let code = child_elements(element).find(|child| child.value().name() == "code");
        let class_language = code
            .and_then(|code| code.attr("class"))
            .and_then(|classes| {
                classes.split_whitespace().find_map(|class| {
                    let language = class.strip_prefix("language-")?;
                    let end = language
                        .find(|character: char| {
                            !character.is_ascii_alphanumeric()
                                && !matches!(character, '_' | '+' | '-')
                        })
                        .unwrap_or(language.len());
                    (end > 0).then_some(&language[..end])
                })
            });
        let language = element
            .attr("data-language")
            .or(class_language)
            .unwrap_or_default();
        let language = if language_name(language) {
            language
        } else {
            ""
        };
        let text = text_content(element);
        let fence = "`".repeat(longest_backticks(&text).max(2) + 1);
        let code = self.protect(format!(
            "{fence}{language}\n{}\n{fence}",
            text.trim_matches('\n')
        ));
        format!("\n\n{code}\n\n")
    }

    fn render_list(&mut self, element: ElementRef<'_>) -> String {
        let tag = element.value().name();
        let lines = child_elements(element)
            .filter(|child| child.value().name() == "li")
            .enumerate()
            .map(|(index, item)| {
                let prefix = if tag == "ol" {
                    format!("{}.", index + 1)
                } else {
                    "-".to_owned()
                };
                let content = self.render_children(item, false);
                format!("{prefix} {}", content.trim().replace('\n', "\n  "))
            })
            .collect::<Vec<_>>();
        format!("\n\n{}\n\n", lines.join("\n"))
    }

    fn render_details(&mut self, element: ElementRef<'_>) -> String {
        let summary = child_elements(element).find(|child| child.value().name() == "summary");
        let title = summary.map_or_else(String::new, |summary| {
            format!(
                "**{}**\n\n",
                compact_markdown(&self.render_children(summary, false))
            )
        });
        let content: String = element
            .children()
            .filter(|child| Some(child.id()) != summary.map(|summary| summary.id()))
            .map(|child| {
                if let Some(text) = child.value().as_text() {
                    escape_angles(text)
                } else {
                    ElementRef::wrap(child)
                        .map_or_else(String::new, |child| self.render_element(child, false))
                }
            })
            .collect();
        format!("\n\n{title}{content}\n\n")
    }

    fn render_table(&mut self, table: ElementRef<'_>) -> String {
        let mut elements = Vec::new();
        table_rows(table, &mut elements);
        let mut header_index = None;
        let mut rows = Vec::new();
        for element in elements {
            let mut row = Vec::new();
            for cell in
                child_elements(element).filter(|cell| matches!(cell.value().name(), "td" | "th"))
            {
                if cell.value().name() == "th" && header_index.is_none() {
                    header_index = Some(rows.len());
                }
                row.push(compact_markdown(&self.render_children(cell, false)).replace('|', "\\|"));
            }
            if !row.is_empty() {
                rows.push(row);
            }
        }
        let Some(columns) = rows.iter().map(Vec::len).max() else {
            return String::new();
        };
        for row in &mut rows {
            row.resize(columns, String::new());
        }
        let header = rows.remove(header_index.unwrap_or_default());
        let line = |row: &[String]| format!("| {} |", row.join(" | "));
        let mut output = format!(
            "\n\n{}\n{}",
            line(&header),
            line(&vec!["---".to_owned(); columns])
        );
        for row in rows {
            output.push('\n');
            output.push_str(&line(&row));
        }
        output.push_str("\n\n");
        output
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        input: String,
        content: String,
        fragment_prefix: String,
        protected_fragments: Vec<String>,
    }

    #[test]
    fn preserves_html_conversion_behavior() {
        let fixtures: Vec<Fixture> =
            serde_json::from_str(include_str!("../test-fixtures/rich-text-html.json")).unwrap();
        for fixture in fixtures {
            let actual = convert_rich_text_html(fixture.input.clone());
            assert_eq!(
                actual,
                RichTextHtml {
                    content: fixture.content,
                    fragment_prefix: fixture.fragment_prefix,
                    protected_fragments: fixture.protected_fragments,
                },
                "HTML input: {}",
                fixture.input
            );
        }
    }
}
