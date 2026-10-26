# Lampa plugins

## tsync.js: TorrServer timeline sync

Keeps Lampa's progress bars current after watching a torrent in VLC on Apple TV.

Lampa reads the timecodes TorrServer keeps for a torrent ("TrackTimecode") only when it builds
the torrent's file list. VLC writes them while it plays, but when you come back Lampa still shows
the old progress in the file list and on the series card until you open the torrent again.

The plugin listens for Lampa's `external` player event and remembers the torrent and its files.
When Lampa comes back to the foreground, it reads that torrent's `/viewed` records from TorrServer
and passes each changed timecode to `Lampa.Timeline`. That redraws the progress bars on screen
(file list, series card). It reads again 3 and 10 seconds later because VLC stores its last
position while it closes. Episodes VLC played by itself (auto-next) are updated too.

It does nothing unless all of these hold:

- the platform is Apple TV and the torrent player (Settings > Player) is VLC;
- "TrackTimecode" is on in Lampa (Settings > Server) and in TorrServer.

On other platforms, or with other players, the external player reports the position back to
Lampa without writing it to TorrServer. Syncing there would replace a fresh position with an
older one.

### Install

Settings > Extensions > Add plugin, then enter the URL the file is hosted at, e.g.
`https://ffoxin.github.io/lampa-plugins/tsync.js`. Lampa loads plugins with a `<script>` tag, so
the host must send a JavaScript content type: GitHub Pages and jsDelivr do, raw gist and
raw.githubusercontent.com URLs do not.

### Test

```
node test/e2e.mjs [path to a Lampa build, default ../lampa]
```

Runs a Lampa build in headless Chrome as an Apple TV against a fake TorrServer. It fires Lampa's
`external` event, freezes and resumes the page the way tvOS does while VLC plays, and checks the
rendered progress bars. Needs Node 22+ and Google Chrome (`CHROME=/path/to/chrome` to override).

## vlcart.js: movie artwork in VLC while a stream opens

While VLC opens a stream it shows its cone on a blurred copy of itself until the first video
frame arrives, which with a torrent can take a while. The VLC build patched for Lampa (branch
`lampa-tvos-fixes` of vlc-ios) can show the movie's backdrop, poster and title there instead.
It takes them as x-callback parameters (`poster`, `backdrop`, `title`, `subtitle`) or, since
Lampa's VLC launch URL carries only the stream URL and a plugin cannot change that template, as
a fragment on the stream URL: `...&play#lampa=<percent-encoded JSON with the same keys>`.

The plugin listens for Lampa's `create` player event and appends that fragment to the stream
URL (and to every quality URL) before Lampa builds the launch URL. A fragment never leaves the
client, so TorrServer never sees it, and VLC strips it before playing. The images are the ones
Lampa shows on the card, through Lampa's own image settings (TMDB poster `w500`, backdrop
`w1280`, or the ready URLs of other sources). For a series the episode line Lampa lists becomes
the subtitle; for a movie the file name is left out.

It does nothing unless the platform is Apple TV and VLC is the chosen player (torrent or
online). Before Lampa's own player starts (`start` event) the fragment is removed again.

### Install

As above, with `https://ffoxin.github.io/lampa-plugins/vlcart.js`. Needs the patched VLC;
the App Store VLC ignores the fragment and shows its cone as before.

### Test

```
node test/e2e-vlcart.mjs [path to a Lampa build, default ../lampa]
```

Calls `Lampa.Player.play()` the way the torrent file list does and reads the
`vlc-x-callback://` URL Lampa navigates to, then checks the artwork in it. Both tests share
`test/harness.mjs` (static server for the build and the plugins, headless Chrome over the
DevTools protocol).
