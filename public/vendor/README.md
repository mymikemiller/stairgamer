# Vendored dependencies

## mp4-muxer 5.2.2 (MIT)

https://github.com/Vanilagy/mp4-muxer

Wraps the H.264 chunks that `VideoEncoder` produces into an MP4 container.
WebCodecs emits raw encoded frames and no container, so a muxer is required to
produce a file Instagram or YouTube will accept.

Vendored rather than loaded from a CDN so the installed PWA keeps working
offline and cannot break when a CDN changes. Update by copying
`functions/node_modules/mp4-muxer/build/mp4-muxer.mjs` after bumping the
package.
