#include "MD4CParser.hpp"
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

int main() {
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
