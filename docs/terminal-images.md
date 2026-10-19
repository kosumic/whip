# Terminal images

Whip's Android and iOS terminal renderers support Kitty graphics. Sixel and
iTerm2 image protocols are disabled in the renderer.

When a server sends graphics output, Whip forwards it through the same ordered
terminal writes as text. Separate graphics messages have no text-frame sequence
and must not trigger sequence-gap recovery.

Herdr 0.9.5 accepts Kitty images in panes, but its direct terminal attachments
omit those images from their ANSI output. Whip uses these attachments, so updating
Whip's graphics forwarding alone does not restore images with that server version.

The server limitation is tracked in
[Herdr issue #5408](https://github.com/herdrdev/herdr/issues/5408). Inline images
through Herdr require a server that forwards image output to terminal
attachments. Whip's client changes can be used with the existing server, but
they do not enable inline images on an unmodified Herdr 0.9.5 server.
