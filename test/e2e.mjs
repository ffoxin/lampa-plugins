// End-to-end check of tsync.js against a real Lampa build in headless Chrome.
//
//   node test/e2e.mjs [path to a Lampa build, default ../lampa]
//
// Serves the build, plays an Apple TV (iPad user agent, 1920x1080), fakes TorrServer's
// /viewed API, fires Lampa's own 'external' player event and checks the progress bars
// after the page is frozen and resumed like it is while VLC plays.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const lampa = path.resolve(process.argv[2] || path.join(root, '..', 'lampa'))
const chromeBin = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const HASH = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' }

// --- static server for the Lampa build and the plugin -------------------------------------

const app = http.createServer((req, res) => {
    let url = decodeURIComponent(req.url.split('?')[0])
    let file = url === '/tsync.js' ? path.join(root, 'tsync.js') : path.join(lampa, url === '/' ? 'index.html' : url)

    fs.readFile(file, (err, data) => {
        if (err) return res.writeHead(404).end()
        res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }).end(data)
    })
})

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

const listen = (server) => new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server.address().port)))
const appPort = await listen(app)
const tsPort = await listen(torrserver)

// --- headless Chrome over the DevTools protocol -------------------------------------------

const profile = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'tsync-chrome-'))
const chrome = spawn(chromeBin, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })

const wsUrl = await new Promise((ok, fail) => {
    let log = ''
    chrome.stderr.on('data', (d) => {
        log += d
        let m = log.match(/DevTools listening on (ws:\S+)/)
        if (m) ok(m[1])
    })
    chrome.on('exit', () => fail(new Error('chrome exited:\n' + log)))
})

const port = new URL(wsUrl).port
const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((ok) => ws.addEventListener('open', ok))

let seq = 0
const pending = new Map()
const consoleLog = []
ws.addEventListener('message', (e) => {
    let msg = JSON.parse(e.data)
    if (msg.method === 'Runtime.consoleAPICalled') consoleLog.push(msg.params.type + ' ' + msg.params.args.map((a) => a.value ?? a.description).join(' '))
    if (msg.method === 'Runtime.exceptionThrown') consoleLog.push('exception ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text))
    if (msg.id && pending.has(msg.id)) {
        let { ok, fail } = pending.get(msg.id)
        pending.delete(msg.id)
        msg.error ? fail(new Error(msg.error.message)) : ok(msg.result)
    }
})
const send = (method, params = {}) => new Promise((ok, fail) => {
    let id = ++seq
    pending.set(id, { ok, fail })
    ws.send(JSON.stringify({ id, method, params }))
})
const run = async (expression) => {
    let r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result.value
}
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))
const waitFor = async (expression, ms = 30000) => {
    for (let end = Date.now() + ms; Date.now() < end; await sleep(200)) {
        if (await run(expression).catch(() => false)) return
    }
    console.log(consoleLog.slice(-40).join('\n'))
    throw new Error('timed out waiting for ' + expression)
}

// --- checks -------------------------------------------------------------------------------

let failures = 0
const check = (name, actual, expected) => {
    let ok = JSON.stringify(actual) === JSON.stringify(expected)
    if (!ok) failures++
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}

const iPad = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'

try {
    await send('Page.enable')
    await send('Runtime.enable')
    await send('Emulation.setUserAgentOverride', { userAgent: iPad })
    await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false })
    // skip the first-run language picker
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.getItem('language') || localStorage.setItem('language', 'ru')` })
    await send('Page.navigate', { url: `http://127.0.0.1:${appPort}/` })
    await waitFor('!!(window.Lampa && Lampa.Timeline && Lampa.Player && window.appready)', 40000)

    check('Lampa detects Apple TV', await run(`Lampa.Platform.is('apple_tv')`), true)

    await run(`(()=>{
        Lampa.Storage.set('torrserver_url', '127.0.0.1:${tsPort}')
        Lampa.Storage.set('torrserver_use_link', 'one')
        Lampa.Storage.set('torrserver_tracktimecode', true)
        Lampa.Storage.set('player_torrent', 'vlc')
    })()`)

    await run(`new Promise((ok, fail) => Lampa.Utils.putScriptAsync(['http://127.0.0.1:${appPort}/tsync.js'], ok, fail))`)
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
    ws.close()
    chrome.kill()
    app.close()
    torrserver.close()
    setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 500)
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exitCode = failures ? 1 : 0
