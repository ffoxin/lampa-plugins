/*
 * Movie artwork for VLC on Apple TV.
 *
 * While VLC opens a stream it shows its cone on a blurred copy of itself until the first video
 * frame arrives. The VLC build patched for Lampa (branch lampa-tvos-fixes) can show the movie's
 * backdrop and poster with its title instead, but Lampa's VLC launch URL carries only the stream
 * URL and a plugin cannot change that template. So the artwork rides on the stream URL itself as
 * a fragment, #lampa=<JSON>: a fragment never leaves the client, TorrServer never sees it, and
 * VLC strips it before playing.
 *
 * Only Apple TV with VLC chosen as the player. The fragment is removed again before Lampa's own
 * player is used.
 */
(function () {
    'use strict';

    if (window.vlcart_plugin) return;
    window.vlcart_plugin = true;

    var MARK = '#lampa=';

    function clean(url) {
        return typeof url === 'string' ? url.split(MARK)[0] : url;
    }

    function tag(url, art) {
        return clean(url) + MARK + encodeURIComponent(JSON.stringify(art));
    }

    function text(value) {
        return Lampa.Utils.clearHtmlTags(String(value || '')).trim();
    }

    // every quality has its own URL and Lampa swaps the chosen one in before launching
    function each(data, fn) {
        data.url = fn(data.url);

        var quality = data.quality;

        if (!quality || typeof quality !== 'object') return;

        for (var key in quality) {
            var item = quality[key];

            if (typeof item === 'string') quality[key] = fn(item);
            else if (item && typeof item.url === 'string') item.url = fn(item.url);
        }
    }

    function vlcSelected(data) {
        return Lampa.Platform.is('apple_tv') && Lampa.Storage.field(data.torrent_hash ? 'player_torrent' : 'player') === 'vlc';
    }

    // the images Lampa shows on the card: TMDB paths through Lampa's image settings, or ready
    // URLs from other sources
    function artwork(data) {
        var active = Lampa.Activity.active() || {};
        var card = data.card || active.movie || {};
        var poster = card.poster_path ? Lampa.Api.img(card.poster_path, 'w500') : card.poster || card.img;
        var backdrop = card.backdrop_path ? Lampa.Api.img(card.backdrop_path, 'w1280') : card.background_image;
        var title = text(card.title || card.name || data.first_title);
        var subtitle = text(data.title);
        var art = {};

        if (poster) art.poster = poster;
        if (backdrop) art.backdrop = backdrop;
        if (title) art.title = title;
        // series: the episode line as Lampa lists it; for a movie data.title is only the file name
        if ((data.episode || data.season) && subtitle && subtitle !== title) art.subtitle = subtitle;

        return art.poster || art.backdrop ? art : null;
    }

    Lampa.Player.listener.follow('create', function (e) {
        var data = e.data;

        if (!data || typeof data.url !== 'string' || !vlcSelected(data)) return;
        if (/youtube\.com|youtu\.be/.test(data.url)) return; // Lampa plays those itself

        var art = artwork(data);

        if (art) each(data, function (url) { return tag(url, art); });
    });

    // Lampa's own player (for example "play in Lampa" from the menu) gets the plain URL back
    Lampa.Player.listener.follow('start', function (data) {
        if (data && typeof data.url === 'string') each(data, clean);
    });
})();
