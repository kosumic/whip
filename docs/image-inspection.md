# Image inspection in Chat View

Image reads use the provider-neutral `AgentToolState.viewed_images` field. Each
entry has a display label and an optional source. Tool identity, status, input,
output, timing, ordering, and ancestry remain owned by the provider adapter.
User attachments continue to use `AgentTranscriptPart::Image`.

The existing tool card displays **Viewed · filename** and expands into the
existing image thumbnail/fullscreen viewer alongside normal tool details.
Collapsed cards do not fetch images. Hidden chats do not load previews. Closing
the card releases its cached remote file; an in-flight download also releases
its file if the card disappears before completion. Search indexes labels, never
image bytes. Image-generating tools retain their ordinary tool presentation.

## Format validation and fixtures

The fixtures in `crates/agent-transcript-core/tests/fixtures/*/image-*` are small,
authored reconstructions of the wire shapes below. IDs, filenames, text, and
image bytes are replacements; private conversations are not checked in.

| Provider | Validated shape | Projection |
| --- | --- | --- |
| Codex | `ImageView { id, path }` completed turn items; `view_image_tool_call { call_id, path }` events | One tool per originating call. Legacy raw calls/results and native items/events update that identity. Paginated raw live placeholders are removed when the image activity arrives. Missing paths retain a metadata-only activity. |
| Claude Code | Local persisted JSONL contains image-only `tool_result.content` arrays with `image.source.{type,data,media_type}`. Rich `toolUseResult` also contains `{ type: "image", file: { base64, type, originalSize, dimensions } }`. | Successful `Read` calls get image metadata only when the result contains structured image evidence. Normal text reads and other tool names remain ordinary tools. Block/rich duplicate representations produce one preview. Relative fallback paths use the result record's `cwd`. |
| OpenCode v1 | Local persisted `part` records confirm the tool/state/input/output envelope. Image FileParts/attachments use `{ type: "file", mime, url, filename? }`. | Assistant image FileParts become image-view tools with their original part IDs. User FileParts remain prompt attachments. Successful `read` attachments become previews on the original tool. Incremental replacement/removal still uses provider part IDs. |
| OpenCode v2 | Projected tool `state.content` contains `{ type: "file", uri, mime, name? }`; the current read implementation emits that content for images. | Successful `read` content becomes preview metadata; image URIs are omitted from textual output. Standalone assistant image file content is also visible. Relative paths use the session directory and the session's remote client. |
| Pi | The read implementation returns `{ type: "image", data, mimeType }`; persisted v3 `toolResult` messages retain structured `content` arrays associated through `toolCallId`. | Successful `read` image results update the original call. Relative fallback paths use the session header's `cwd`. Branch ancestry continues to control whether the read belongs to the visible conversation. |

Codex definitions were checked against
[items.rs](https://github.com/openai/codex/blob/326bac6ce0ad9e91fbe5db1d2be5534bed1b50b5/codex-rs/protocol/src/items.rs)
and [protocol.rs](https://github.com/openai/codex/blob/326bac6ce0ad9e91fbe5db1d2be5534bed1b50b5/codex-rs/protocol/src/protocol.rs).
OpenCode's current [read implementation](https://github.com/anomalyco/opencode/blob/b705c446f076c58600d1f0cece8c554cad4d62f7/packages/core/src/tool/plugin/read.ts)
confirms the v2 image content shape. Pi's
[read implementation](https://github.com/badlogic/pi-mono/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/tools/read.ts)
confirms its image result shape. The cached public Pi captures used by
`scripts/test-pi-transcript.ts` contain no image-bearing tool results, so the
Pi image fixture is reconstructed from the implementation and the persisted
session envelope rather than presented as an actual image capture.

## Bounds and unavailable sources

Each tool result retains at most eight image entries and 64 KiB of inline image
URIs in total. Path/URL sources and labels are limited to 8 KiB. Larger inline
payloads retain the activity and can fall back to the recorded read path. The
existing remote preview file-size limit also applies before download. These
limits apply to normalized images; Codex's existing checkpoint continues to
retain its authoritative raw rollout prefix for replay.

Paths, `file:///` URIs, HTTP(S) URLs, and bounded image data URIs can provide
previews. An absent file, inaccessible host, expired URL, omitted bytes, oversized
inline image without a path, or opaque blob/resource identifier cannot supply
image content from the transcript alone. Such records still show a label and
unavailable preview. Whip does not guess that a text read returned an image based
on its filename or prose, resolve opaque provider blobs, or recover historical
bytes from an overwritten file. Arbitrary image-bearing outputs from generators
and unrelated tools are not classified as image reads.

No Herdr server change is needed. Older normalized Claude, Pi, and OpenCode
checkpoints remain readable offline and require source revalidation to recover
image evidence that those older checkpoints discarded.
