/*
 * TorrServer timeline sync for Lampa on Apple TV with VLC as the torrent player.
 *
 * Lampa reads the timecodes TorrServer keeps for a torrent ("TrackTimecode") only when it
 * builds the torrent's file list. VLC writes them while it plays, so after returning from VLC
 * the list and the series card keep the old progress until the torrent is opened again.
 * On return this plugin re-reads the torrent's /viewed records and passes the new timecodes
 * to Lampa's timeline, which redraws every progress bar of those files on screen.
 *
 * Only Apple TV + VLC: elsewhere external players report the position back to Lampa without
 * writing TorrServer, and syncing would overwrite that fresher value with an older one.
 */
(function () {
    'use strict';

    if (window.tsync_plugin) return;
    window.tsync_plugin = true;

    var network = new Lampa.Reguest();
    var session = null; // torrent handed to VLC: {hash, files: {file_index: timeline}, synced}
    var timers = [];
    var tick = Date.now();

    function streamIndex(url) {
        var match = (url || '').match(/[?&]index=(\d+)/);

        return match ? parseInt(match[1], 10) : 0;
    }

    function remember(data) {
        session = null;

        if (!Lampa.Platform.is('apple_tv') || !data.torrent_hash || Lampa.Storage.field('player_torrent') !== 'vlc') return;

        // VLC goes on to the next episodes by itself, so keep the whole list
        var files = {};

        (data.playlist && data.playlist.length ? data.playlist : [data]).forEach(function (item) {
            var index = item.id || streamIndex(item.url);

            if (index && item.timeline) files[index] = item.timeline;
        });

        session = { hash: data.torrent_hash, files: files, synced: false };
    }

    // same percent as Lampa computes when it builds the file list
    function apply(timeline, timecode) {
        var view = Lampa.Timeline.view(timeline.hash);
        var duration = timeline.duration || view.duration;
        var time = Math.round(timecode);
        var percent = duration > 0 ? Math.min(100, Math.round(time / duration * 100)) : view.percent;

        if (time === view.time && percent === view.percent) return;

        timeline.time = time;
        timeline.percent = percent;
        timeline.duration = duration;

        view.handler(percent, time, duration);
    }

    function sync() {
        var url = Lampa.Torserver.url();
        var files = session && session.files;

        if (!files || !url || !Lampa.Storage.field('torrserver_tracktimecode')) return;

        network.timeout(5000);
        network.silent(url + '/viewed', function (records) {
            (Array.isArray(records) ? records : []).forEach(function (record) {
                if (files[record.file_index] && record.timecode > 0) apply(files[record.file_index], record.timecode);
            });
        }, false, JSON.stringify({ action: 'list', hash: session.hash }));
    }

    // VLC stores its last position while it is closing, so read again a few seconds later
    function returned() {
        if (!session) return;

        session.synced = true;

        timers.forEach(clearTimeout);
        timers = [0, 3000, 10000].map(function (delay) {
            return setTimeout(sync, delay);
        });
    }

    Lampa.Player.listener.follow('external', remember);

    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') returned();
    });

    // a web view frozen in the background may wake up without a visibility event
    setInterval(function () {
        if (Date.now() - tick > 5000) returned();

        tick = Date.now();
    }, 1000);

    // last resort: the first remote press back in Lampa
    Lampa.Keypad.listener.follow('keydown', function () {
        if (session && !session.synced) returned();
    });
})();
