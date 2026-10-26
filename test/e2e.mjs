// End-to-end check of tsync.js against a real Lampa build in headless Chrome.
//
//   node test/e2e.mjs [path to a Lampa build, default ../lampa]
//
// Serves the build, plays an Apple TV (iPad user agent, 1920x1080), fakes TorrServer's
// /viewed API, fires Lampa's own 'external' player event and checks the progress bars
// after the page is frozen and resumed like it is while VLC plays.

import http from 'node:http'
import { launch, listen, sleep, report } from './harness.mjs'

const HASH = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'

// --- fake TorrServer ----------------------------------------------------------------------

let viewed = []      // records /viewed {"action":"list"} answers with
let viewedCalls = 0

const torrserver = http.createServer((req, res) => {
    let cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }
    if (req.method === 'OPTIONS') return res.writeHead(204, cors).end()

    let body = ''
    req.on('data', (c) => body += c)
    req.on('end', () => {
        if (req.url.startsWith('/viewed')) {
            let json = JSON.parse(body || '{}')
            viewedCalls++
            res.writeHead(200, { ...cors, 'Content-Type': 'application/json' })
            return res.end(JSON.stringify(viewed.filter((v) => v.hash === json.hash)))
        }
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }).end('{}')
    })
})

const tsPort = await listen(torrserver)
const { send, run, check, open, plugin, close, failed } = await launch({ '/tsync.js': new URL('../tsync.js', import.meta.url).pathname })

try {
    await open()

    check('Lampa detects Apple TV', await run(`Lampa.Platform.is('apple_tv')`), true)

    await run(`(()=>{
        Lampa.Storage.set('torrserver_url', '127.0.0.1:${tsPort}')
        Lampa.Storage.set('torrserver_use_link', 'one')
        Lampa.Storage.set('torrserver_tracktimecode', true)
        Lampa.Storage.set('player_torrent', 'vlc')
    })()`)

    await plugin('/tsync.js')
    check('plugin loaded', await run('window.tsync_plugin'), true)

    // a two-episode torrent shaped like the elements torrent.js passes to Player.play
    await run(`(()=>{
        let hashes = [1, 2].map(e => Lampa.Utils.hash([1, '', e, 'Test Show ' + Date.now()].join('')))
        let playlist = hashes.map((hash, i) => {
            let timeline = Lampa.Timeline.view(hash)
            timeline.duration = 2400   // from the episode runtime, 40 min
            document.body.appendChild(Lampa.Timeline.render(timeline)[0])
            return {
                id: i + 1,
                url: 'http://127.0.0.1:${tsPort}/stream/e' + (i + 1) + '.mkv?link=${HASH}&index=' + (i + 1) + '&play',
                torrent_hash: '${HASH}',
                timeline
            }
        })
        playlist.forEach(p => p.playlist = playlist)
        window.__t = { hashes, playlist }
    })()`)

    const bar = (i) => run(`$('.time-line[data-hash="' + __t.hashes[${i}] + '"] > div')[0].style.width`)
    const stored = (i) => run(`(v => [v.time, v.percent, v.duration])(Lampa.Timeline.view(__t.hashes[${i}]))`)
    const external = (i = 0) => run(`Lampa.Player.listener.send('external', __t.playlist[${i}])`)
    const freeze = async (ms) => {
        await send('Page.setWebLifecycleState', { state: 'frozen' })
        await sleep(ms)
        await send('Page.setWebLifecycleState', { state: 'active' })
    }

    // 1. nothing is fetched while Lampa is just open
    await sleep(1500)
    check('no requests without a launch', viewedCalls, 0)

    // 2. launch episode 1 in VLC; VLC finishes it and plays half of episode 2 (auto-next)
    await external(0)
    viewed = [
        { hash: HASH, file_index: 1, timecode: 2400 },
        { hash: HASH, file_index: 2, timecode: 1200 },
    ]
    await freeze(7000)
    await sleep(1000)
    check('episode 1 bar after return (freeze)', await bar(0), '100%')
    check('episode 2 bar after return (freeze)', await bar(1), '50%')
    check('episode 2 stored timeline', await stored(1), [1200, 50, 2400])
    check('playlist element timeline kept in step', await run('__t.playlist[1].timeline.time'), 1200)

    // 3. VLC's last write lands after Lampa is back: the retry at +3 s picks it up
    viewed[1].timecode = 1500
    await sleep(3000)
    check('late write picked up by the retry', await bar(1), '63%')

    // 4. return signalled by visibilitychange only (headless Chrome stays 'hidden' after a
    //    lifecycle freeze, so the page's visibility is driven by hand: hidden, then visible)
    await external(1)
    viewed[1].timecode = 1800
    await run(`(()=>{
        let state = 'hidden'
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
        document.dispatchEvent(new Event('visibilitychange'))
        state = 'visible'
        document.dispatchEvent(new Event('visibilitychange'))
    })()`)
    await sleep(800)
    check('visibilitychange triggers a sync', await bar(1), '75%')

    // 5. return signalled only by the first remote press
    await external(1)
    viewed[1].timecode = 2100
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 })
    await sleep(800)
    check('first keydown triggers a sync', await bar(1), '88%')

    // 6. no sync when another player or setting is in use
    for (let [name, setup] of [
        ['Infuse as torrent player', `Lampa.Storage.set('player_torrent', 'infuse')`],
        ['TrackTimecode off', `Lampa.Storage.set('player_torrent', 'vlc'); Lampa.Storage.set('torrserver_tracktimecode', false)`],
        ['not Apple TV', `Lampa.Storage.set('torrserver_tracktimecode', true); Lampa.Storage.set('platform', 'android')`],
    ]) {
        await run(setup)
        await external(1)
        viewed[1].timecode = 300
        let before = viewedCalls
        await freeze(6000)
        await sleep(1000)
        check(`${name}: no request, bar unchanged`, [viewedCalls - before, await bar(1)], [0, '88%'])
    }
} finally {
    close()
    torrserver.close()
}

report(failed())
