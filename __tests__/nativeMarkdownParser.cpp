#include "MD4CParser.hpp"
#include "SpeechPresentation.hpp"
#include <cstdlib>
#include <iostream>
#include <string>

using Markdown::MarkdownASTNode;
using Markdown::NodeType;

static std::string plainText(const std::shared_ptr<MarkdownASTNode> &node) {
  std::string result = node->content;
  if (node->type == NodeType::LineBreak || node->type == NodeType::SoftBreak) {
    result += '\n';
  }
  for (const auto &child : node->children) {
    result += plainText(child);
  }
  return result;
}

static void expectText(const std::string &markdown, const std::string &expected) {
  Markdown::MD4CParser parser;
  Markdown::Md4cFlags flags;
  flags.latexMath = false;
  flags.hardSoftBreaks = true;
  flags.preserveBlankLines = true;
  const auto actual = plainText(parser.parse(markdown, flags, false));
  if (actual != expected) {
    std::cerr << "Native Markdown text mismatch\nInput: " << markdown
              << "\nExpected: " << expected << "\nActual: " << actual << '\n';
    std::exit(EXIT_FAILURE);
  }
}

static void expectSpeech(const std::string &original, const std::string &marked,
                         const std::string &current) {
  Markdown::MD4CParser parser;
  Markdown::Md4cFlags flags;
  flags.highlight = true;
  auto source = parser.parse(original, flags, true);
  auto result = Markdown::prepareSpeech(parser, original, parser.parse(marked, flags, true), flags, true);
  Markdown::SpeechProjection projection;
  Markdown::projectSpeech(result, projection);
  std::string actual;
  size_t markers = 0;
  for (const auto &mark : projection.marks) {
    if (mark.node->attributes.count(Markdown::SpeechCurrentAttribute)) {
      actual = plainText(mark.node);
      markers++;
    }
  }
  if (plainText(source) != plainText(result) || actual != current || markers != (current.empty() ? 0 : 1)) {
    std::cerr << "Speech presentation changed original text or selected the wrong word: " << marked << '\n';
    std::exit(EXIT_FAILURE);
  }
}

int main() {
  expectSpeech("One two One", "One two ==One==", "One");
  expectSpeech("One two One", "One ==two== One", "two");
  expectSpeech("**Read [the guide](https://example.com)**", "**Read [the ==guide==](https://example.com)**", "guide");
  expectSpeech("==Earlier== and current", "==Earlier== and ==current==", "current");
  expectSpeech("`a == b` then current", "`a == b` then ==current==", "current");
  expectSpeech("# Heading\n\n- First\n- Second", "# Heading\n\n- First\n- ==Second==", "Second");
  expectSpeech("你好 👋 world", "你==好== 👋 world", "好");
  expectSpeech("A `word` here", "A ==`word`== here", "word");
  expectSpeech("| A | B |\n| --- | --- |\n| one | two |", "| A | B |\n| --- | --- |\n| one | ==two== |", "two");
  expectSpeech("==Existing==", "==Existing==", "");
  expectSpeech("Original words", "==Different== words", "");
  // SelectableChatText encodes each character to keep prompts literal.
  expectText("&#99;&#111;&#109;&#109;&#105;&#116;", "commit");
  expectText("&#32;&#32;&#32;&#32;&#42;&#42;&#108;&#105;&#116;&#101;&#114;&#97;&#108;&#42;&#42;"
             "&#32;&#60;&#116;&#97;&#103;&#62;&#32;&#38;&#97;&#109;&#112;&#59;&#32;&#36;&#120;&#36;",
             "    **literal** <tag> &amp; $x$");
  expectText("&#20013;&#25991;&#32;&#128512;", "中文 😀");
  expectText("&#x4E2D;&#X6587;&#x20;&#x1F600;", "中文 😀");
  expectText("&#0; &#55296; &#1114112;", "� � �");
  // Entities must not be decoded recursively or interpreted as Markdown syntax.
  expectText("&#38;&#35;&#57;&#57;&#59;", "&#99;");
  expectText("`&#99;`", "&#99;");
  expectText("&#x; &MadeUpEntity;", "&#x; &MadeUpEntity;");
  std::cout << "Native Markdown parser tests passed\n";
}
