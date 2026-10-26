// Shared harness for the plugin tests: serves a Lampa build with the plugin files next to it
// and drives headless Chrome as an Apple TV (iPad user agent, 1920x1080) over the DevTools
// protocol. Navigations the page requests are collected (Page.frameRequestedNavigation), which
// is how a test sees the vlc-x-callback:// URL Lampa hands to VLC.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
export const lampa = path.resolve(process.argv[2] || path.join(root, '..', 'lampa'))
const chromeBin = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' }

export const listen = (server) => new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server.address().port)))
export const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))

const iPad = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'

// plugins: {'/tsync.js': '/abs/path/tsync.js'} served next to the Lampa build
export async function launch(plugins = {}) {
    const app = http.createServer((req, res) => {
        let url = decodeURIComponent(req.url.split('?')[0])
        let file = plugins[url] || path.join(lampa, url === '/' ? 'index.html' : url)

        fs.readFile(file, (err, data) => {
            if (err) return res.writeHead(404).end()
            res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }).end(data)
        })
    })
    const appPort = await listen(app)

    const profile = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'lampa-chrome-'))
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
    const consoleLog = []   // page console + Chrome's own log entries, as text
    const navigations = [] // URLs the page asked to navigate to, vlc-x-callback:// included
    ws.addEventListener('message', (e) => {
        let msg = JSON.parse(e.data)
        if (msg.method === 'Page.frameRequestedNavigation' || msg.method === 'Page.frameScheduledNavigation') navigations.push(msg.params.url)
        if (msg.method === 'Runtime.consoleAPICalled') consoleLog.push(msg.params.type + ' ' + msg.params.args.map((a) => a.value ?? a.description).join(' '))
        if (msg.method === 'Runtime.exceptionThrown') consoleLog.push('exception ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text))
        if (msg.method === 'Log.entryAdded') consoleLog.push(msg.params.entry.level + ' ' + msg.params.entry.text)
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
    const waitFor = async (expression, ms = 30000) => {
        for (let end = Date.now() + ms; Date.now() < end; await sleep(200)) {
            if (await run(expression).catch(() => false)) return
        }
        console.log(consoleLog.slice(-40).join('\n'))
        throw new Error('timed out waiting for ' + expression)
    }

    let failures = 0
    const check = (name, actual, expected) => {
        let ok = JSON.stringify(actual) === JSON.stringify(expected)
        if (!ok) failures++
        console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
    }

    const close = () => {
        ws.close()
        chrome.kill()
        app.close()
        setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 500)
    }

    const open = async () => {
        await send('Page.enable')
        await send('Runtime.enable')
        await send('Log.enable')
        await send('Emulation.setUserAgentOverride', { userAgent: iPad })
        await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false })
        // skip the first-run language picker
        await send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.getItem('language') || localStorage.setItem('language', 'ru')` })
        await send('Page.navigate', { url: `http://127.0.0.1:${appPort}/` })
        await waitFor('!!(window.Lampa && Lampa.Timeline && Lampa.Player && window.appready)', 40000)
    }

    const plugin = async (name) => {
        await run(`new Promise((ok, fail) => Lampa.Utils.putScriptAsync(['http://127.0.0.1:${appPort}${name}'], ok, fail))`)
    }

    return { appPort, send, run, waitFor, check, consoleLog, navigations, open, plugin, close, failed: () => failures }
}

export function report(failures) {
    console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
    process.exitCode = failures ? 1 : 0
}
