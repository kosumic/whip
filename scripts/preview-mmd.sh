#!/usr/bin/env bash

set -euo pipefail

usage() {
  echo "Usage: $0 path/to/diagram.mmd" >&2
}

if [[ $# -ne 1 ]]; then
  usage
  exit 2
fi

diagram=$1
if [[ ! -f $diagram ]]; then
  echo "Diagram not found: $diagram" >&2
  exit 1
fi

diagram=$(realpath "$diagram")
preview_dir=$(mktemp -d -t whip-mermaid-preview.XXXXXX)
puppeteer_config="$preview_dir/puppeteer.json"
preview_svg="$preview_dir/preview.svg"
preview_html="$preview_dir/index.html"
port_file="$preview_dir/port"
server_pid=""
browser_pid=""

cleanup() {
  if [[ -n $browser_pid ]]; then
    kill "$browser_pid" >/dev/null 2>&1 || true
    wait "$browser_pid" 2>/dev/null || true
  fi
  if [[ -n $server_pid ]]; then
    kill "$server_pid" >/dev/null 2>&1 || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf -- "$preview_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

find_command() {
  local candidate
  for candidate in "$@"; do
    if command -v "$candidate" >/dev/null 2>&1; then
      command -v "$candidate"
      return 0
    fi
  done
  return 1
}

renderer_browser=$(find_command google-chrome chromium chromium-browser brave) || {
  echo "A Chromium-based browser is required to render Mermaid diagrams." >&2
  exit 1
}

printf '{"executablePath":"%s","args":["--no-sandbox"]}\n' \
  "$renderer_browser" >"$puppeteer_config"

cat >"$preview_html" <<'HTML'
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Mermaid preview</title>
    <style>
      html, body { margin: 0; min-height: 100%; background: white; }
      body { display: grid; place-items: start center; }
      #diagram { width: 100%; }
      #diagram svg { display: block; width: 100%; height: auto; }
    </style>
  </head>
  <body>
    <main id="diagram" aria-label="Mermaid diagram"></main>
    <script>
      const diagram = document.querySelector('#diagram');
      let previousSvg = '';

      async function refresh() {
        try {
          const response = await fetch(`preview.svg?updated=${Date.now()}`, {
            cache: 'no-store',
          });
          const svg = await response.text();
          if (response.ok && svg !== previousSvg) {
            diagram.innerHTML = svg;
            previousSvg = svg;
          }
        } catch {
          // A render may be replacing the file; the next poll will retry.
        }
      }

      refresh();
      setInterval(refresh, 750);
    </script>
  </body>
</html>
HTML

render() {
  echo "Rendering $diagram"
  npx --yes -p @mermaid-js/mermaid-cli mmdc \
    -p "$puppeteer_config" \
    -i "$diagram" \
    -o "$preview_svg" \
    -b white
}

render

node - "$preview_dir" "$port_file" <<'NODE' &
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const root = process.argv[2];
const portFile = process.argv[3];
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
};

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!['index.html', 'preview.svg'].includes(filename)) {
    response.writeHead(404).end();
    return;
  }

  const file = path.join(root, filename);
  fs.readFile(file, (error, data) => {
    if (error) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': contentTypes[path.extname(file)],
    });
    response.end(data);
  });
});

server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(portFile, String(server.address().port));
});
NODE
server_pid=$!

for _ in {1..50}; do
  [[ -s $port_file ]] && break
  if ! kill -0 "$server_pid" 2>/dev/null; then
    echo "Preview server failed to start." >&2
    exit 1
  fi
  sleep 0.1
done

if [[ ! -s $port_file ]]; then
  echo "Timed out waiting for the preview server." >&2
  exit 1
fi

preview_url="http://127.0.0.1:$(<"$port_file")/"

if [[ ${MMD_PREVIEW_NO_OPEN:-0} != 1 ]]; then
  preview_browser=$(find_command brave google-chrome chromium chromium-browser) || \
    preview_browser=$renderer_browser
  "$preview_browser" \
    --app="$preview_url" \
    --user-data-dir="$preview_dir/browser-profile" \
    --disable-background-mode \
    --no-default-browser-check \
    --no-first-run \
    >/dev/null 2>&1 &
  browser_pid=$!
fi

echo "Preview: $preview_url"
echo "Watching for changes. Close the preview window or press Ctrl-C to stop."
last_state=$(stat -c '%y:%s' "$diagram")

while sleep 0.5; do
  if [[ -n $browser_pid ]] && ! kill -0 "$browser_pid" 2>/dev/null; then
    echo "Preview window closed."
    break
  fi
  current_state=$(stat -c '%y:%s' "$diagram")
  if [[ $current_state != "$last_state" ]]; then
    last_state=$current_state
    if ! render; then
      echo "Render failed; waiting for the next change." >&2
    fi
  fi
done
