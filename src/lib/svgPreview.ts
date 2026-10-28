import { parse } from 'react-native-svg';

/** SVG image documents preserve browser layout without executing embedded scripts. */
export function svgPreviewHtml(content: string): string {
  const root = parse(content);
  if (!root) throw new Error('The SVG document is empty');
  if (root.tag.toLowerCase() !== 'svg') {
    throw new Error('The document root must be an SVG element');
  }

  // Keep the SVG in an image document: foreignObject labels and CSS work, while
  // scripts, navigation, and external resource loads inside the image are inert.
  // Rendering paths with markers through react-native-svg can crash Android.
  const image = root.props.xmlns ? content : content.replace(/<svg(?=[\s>])/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  const source = `data:image/svg+xml,${encodeURIComponent(image)}`;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=5,user-scalable=yes">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
  <style>
    html, body { width: 100%; height: 100%; margin: 0; background: transparent; }
    body { box-sizing: border-box; padding: 16px; }
    img { display: block; width: 100%; height: 100%; object-fit: contain; }
  </style>
</head>
<body><img alt="" src="${source}"></body>
</html>`;
}
