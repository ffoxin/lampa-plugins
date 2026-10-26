// End-to-end check of vlcart.js against a real Lampa build in headless Chrome.
//
//   node test/e2e-vlcart.mjs [path to a Lampa build, default ../lampa]
//
// Plays an Apple TV with VLC chosen as the player, calls Lampa.Player.play() the way the
// torrent file list does and reads the vlc-x-callback:// URL Lampa navigates to. Then checks
// what the plugin put into the stream URL.

import { launch, sleep, report } from './harness.mjs'

const HASH = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'
const TS = '127.0.0.1:1'   // the fake TorrServer address Lampa recognises its own stream URLs by

const { run, check, navigations, open, plugin, close, failed } = await launch({ '/vlcart.js': new URL('../vlcart.js', import.meta.url).pathname })

// the stream URL and the #lampa= artwork VLC would receive from a vlc-x-callback:// URL
const unpack = (launchURL) => {
    let stream = decodeURIComponent(new URL(launchURL).searchParams.get('url'))
    let [url, fragment] = stream.split('#lampa=')
    return { url, art: fragment ? JSON.parse(decodeURIComponent(fragment)) : null }
}
// the last vlc-x-callback:// navigation the page requested; taken out for the next launch
const launched = () => {
    let i = navigations.findLastIndex((url) => url.startsWith('vlc-x-callback://'))
    return i < 0 ? null : navigations.splice(i, 1)[0]
}
const play = async (data) => {
    let external = await run(`new Promise((ok) => {
        let data = ${JSON.stringify(data)}
        let once = (e) => { Lampa.Player.listener.remove('external', once); ok(e.url) }
        Lampa.Player.listener.follow('external', once)
        Lampa.Player.play(data)
        setTimeout(() => ok(null), 4000)
    })`)
    await sleep(800)
    return { external, launch: launched() }
}
const stream = (index) => `http://${TS}/stream/e${index}.mkv?link=${HASH}&index=${index}&play`
const card = { id: 7, name: 'Test <b>Show</b>', title: 'Test Show', poster_path: '/p.jpg', backdrop_path: '/b.jpg', number_of_seasons: 1 }
// the return URL VLC opens when playback ends: Lampa's own Infuse convention (no x-error: the
// client would answer infuseDidFail with an "Infuse failed" alert on top of VLC's own)
const back = { 'x-success': 'lampa://infuseDidFinish' }

try {
    await open()
    check('Lampa detects Apple TV', await run(`Lampa.Platform.is('apple_tv')`), true)
    // headless Chrome runs on a Mac: Lampa would pick its macOS player list, which has no VLC
    await run(`Lampa.Platform.macOS = () => false`)
    check('Lampa does not take the iOS or macOS launch path', await run(`[Lampa.Platform.is('apple'), Lampa.Platform.macOS()]`), [false, false])

    await run(`(()=>{
        Lampa.Storage.set('torrserver_url', '${TS}')
        Lampa.Storage.set('torrserver_use_link', 'one')
        Lampa.Storage.set('player_torrent', 'vlc')
        Lampa.Storage.set('player', 'vlc')
    })()`)
    await plugin('/vlcart.js')
    check('plugin loaded', await run('window.vlcart_plugin'), true)

    const poster = await run(`Lampa.Api.img('/p.jpg', 'w500')`)
    const backdrop = await run(`Lampa.Api.img('/b.jpg', 'w1280')`)
    check('TMDB image URLs resolve', [poster.includes('/w500/'), backdrop.includes('/w1280/')], [true, true])

    // 1. a series episode from the torrent file list
    let episode = { url: stream(3), torrent_hash: HASH, title: '3 / Pilot', season: 1, episode: 3, first_title: 'Test Show', card }
    let r = await play(episode)
    check('VLC launched through vlc-x-callback', r.launch !== null && r.launch.startsWith('vlc-x-callback://x-callback-url/stream?url='), true)
    let { url, art } = unpack(r.launch)
    check('stream URL kept intact before the fragment', url, stream(3))
    check('artwork: poster, backdrop, title, episode, return URL', art, { poster, backdrop, title: 'Test Show', subtitle: '3 / Pilot', ...back })
    check("'external' listeners (tsync) get the tagged URL and still find the file index", [r.external.startsWith(stream(3) + '#lampa='), (r.external.match(/[?&]index=(\d+)/) || [])[1]], [true, '3'])
    check('playing again does not stack fragments', unpack((await play({ ...episode, url: r.external })).launch).url, stream(3))

    // 2. a movie: the file name is not worth a subtitle
    let movie = { url: stream(1), torrent_hash: HASH, title: 'Movie.2020.1080p.mkv', first_title: 'Test Movie', card: { id: 8, title: 'Test Movie', poster_path: '/m.jpg', backdrop_path: '/mb.jpg' } }
    r = await play(movie)
    check('movie: title without subtitle', unpack(r.launch).art, { poster: await run(`Lampa.Api.img('/m.jpg', 'w500')`), backdrop: await run(`Lampa.Api.img('/mb.jpg', 'w1280')`), title: 'Test Movie', ...back })

    // 3. a card from another source carries ready image URLs
    let other = { url: stream(1), torrent_hash: HASH, title: 'x.mkv', card: { title: 'Other', poster: 'https://img.example/poster.jpg', background_image: 'https://img.example/back.jpg' } }
    check('ready image URLs are passed as they are', unpack((await play(other)).launch).art, { poster: 'https://img.example/poster.jpg', backdrop: 'https://img.example/back.jpg', title: 'Other', ...back })

    // 4. nothing to show: the fragment still carries the way back
    let bare = { url: stream(2), torrent_hash: HASH, title: 'x.mkv' }
    let bareLaunch = unpack((await play(bare)).launch)
    check('no card: stream URL with only the return URL', { url: bareLaunch.url, keys: Object.keys(bareLaunch.art).filter((k) => k !== 'title'), back: { 'x-success': bareLaunch.art['x-success'] } }, { url: stream(2), keys: ['x-success'], back })

    // 4b. the client's own URL scheme, as Lampa's Infuse template reads it; junk falls back to lampa://
    for (let [stored, scheme] of [['lampamx', 'lampamx'], ['undefined', 'lampa'], ['', 'lampa'], ['not a scheme', 'lampa']]) {
        await run(`Lampa.Storage.set('apple_tv_client', ${JSON.stringify(stored)})`)
        let art = unpack((await play(bare)).launch).art
        check(`apple_tv_client ${JSON.stringify(stored)}: return URL uses ${scheme}://`, [art['x-success'], art['x-error']], [`${scheme}://infuseDidFinish`, undefined])
    }
    await run(`localStorage.removeItem('apple_tv_client')`)

    // 5. 'create' alone for an online (non-torrent) source, with the quality list Lampa swaps in
    let online = await run(`(()=>{
        let data = { url: 'http://cdn.example/v720.mp4', quality: { '720p': 'http://cdn.example/v720.mp4', '1080p': { url: 'http://cdn.example/v1080.mp4' } }, title: 'Online', card: ${JSON.stringify(card)} }
        Lampa.Player.listener.send('create', { data, abort: () => {} })
        return data
    })()`)
    check('online source: every quality URL tagged', [online.url.includes('#lampa='), online.quality['720p'].includes('#lampa='), online.quality['1080p'].url.includes('#lampa=')], [true, true, true])

    // 6. Lampa's own player gets clean URLs back
    let started = await run(`(()=>{
        let data = ${JSON.stringify(online)}
        Lampa.Player.listener.send('start', data)
        return data
    })()`)
    check("'start' (inner player) strips the fragment", [started.url, started.quality['720p'], started.quality['1080p'].url], ['http://cdn.example/v720.mp4', 'http://cdn.example/v720.mp4', 'http://cdn.example/v1080.mp4'])

    // 7. other players or platforms: untouched
    for (let [name, setup] of [
        ['Infuse as torrent player', `Lampa.Storage.set('player_torrent', 'infuse')`],
        ['not Apple TV', `Lampa.Storage.set('player_torrent', 'vlc'); Lampa.Storage.set('platform', 'android')`],
    ]) {
        await run(setup)
        let data = await run(`(()=>{
            let data = ${JSON.stringify(episode)}
            Lampa.Player.listener.send('create', { data, abort: () => {} })
            return data
        })()`)
        check(`${name}: stream URL untouched`, data.url, stream(3))
    }
} finally {
    close()
}

report(failed())
