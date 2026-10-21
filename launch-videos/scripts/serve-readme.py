# /// script
# dependencies = ["markdown-it-py==3.0.0"]
# ///
"""Serve the real repository README for simulator browser captures (uv run)."""

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from markdown_it import MarkdownIt


STYLE = """
body { margin: 0; color: #20242a; background: #fff; font: 17px/1.6 -apple-system, sans-serif; }
article { max-width: 940px; margin: auto; padding: 32px 24px 80px; overflow-wrap: anywhere; }
h1, h2, h3 { line-height: 1.25; margin-top: 1.5em; }
h1 { font-size: 36px; } h2 { font-size: 26px; border-bottom: 1px solid #d8dee4; padding-bottom: 8px; }
a { color: #0969da; } img { max-width: 100%; height: auto; vertical-align: middle; }
p[align=center] { margin: 24px 0; } p[align=center] img { margin: 3px; }
table { border-collapse: collapse; width: 100%; } td, th { padding: 12px; border: 1px solid #d8dee4; }
td { width: 50%; } pre { padding: 16px; overflow: auto; background: #f6f8fa; border-radius: 8px; }
code { font: .85em/1.6 ui-monospace, monospace; }
"""


class ReadmeHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.split("?", 1)[0] != "/":
            return super().do_GET()
        markdown = (Path(self.directory) / "README.md").read_text()
        body = MarkdownIt("commonmark", {"html": True}).enable("table").render(markdown)
        page = (
            '<!doctype html><html lang="en"><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width, initial-scale=1">'
            f"<title>Whip — README</title><style>{STYLE}</style><article>{body}</article></html>"
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(page)))
        self.end_headers()
        self.wfile.write(page)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--port", type=int, default=8794)
    args = parser.parse_args()
    handler = partial(ReadmeHandler, directory=str(args.root.resolve()))
    print(f"Serving {args.root.resolve() / 'README.md'} at http://127.0.0.1:{args.port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), handler).serve_forever()
