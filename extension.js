import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import Soup from 'gi://Soup';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const MPRIS_PLAYER_PATH = '/org/mpris/MediaPlayer2';

// Top-bar lyric: its width outside the left-half mode, its font size (matches
// stylesheet.css) and the smallest size a long line may shrink to before it is ellipsized
const LABEL_DEFAULT_WIDTH_PX = 344;
const LABEL_FONT_PX = 13;
const LABEL_MIN_FONT_PX = 11;
// Left-half mode: room left before the clock, and a floor for odd panel layouts
const CLOCK_GAP_PX = 8;
const LABEL_MIN_FILL_WIDTH_PX = 200;
// Space kept above and below the dropdown when the square would not fit on screen
const MENU_SCREEN_MARGIN_PX = 24;
// Dropdown width the track title, artist, playback buttons and the card's padding
// keep their stylesheet size at (the default 344px label in its panel button); a wider dropdown scales them
// up to match
const CARD_BASE_WIDTH_PX = 368;
const MPRIS_PLAYER_INTERFACE = 'org.mpris.MediaPlayer2.Player';

// Lyrics API configuration
const LYRICS_API_URL = 'https://lrclib.net/api/get';
const LYRICS_SEARCH_URL = 'https://lrclib.net/api/search';
const LYRICS_DURATION_TOLERANCE_S = 5;
const LYRICS_CACHE_MAX_BYTES = 10 * 1024 * 1024;
const LYRICS_CACHE_PRUNE_INTERVAL_US = 10 * 60 * GLib.USEC_PER_SEC;
// A sung line held longer than this with no next line is treated as an
// instrumental stretch (solos, outros) and the track title is shown instead
const LYRIC_LINE_MAX_MS = 10000;
// Lines that only mark music, e.g. "♪" or "(instrumental)"
const INSTRUMENTAL_LINE_RE = /^[\s♪♫♬♩🎵🎶()[\]-]*(instrumental)?[\s♪♫♬♩🎵🎶()[\]-]*$/iu;

// Transition timings
const TEXT_FADE_OUT_MS = 120;
const TEXT_FADE_IN_MS = 180;
const ALBUM_ART_CROSSFADE_MS = 300;
const ART_LYRICS_SCROLL_MS = 450;
// Upper bound on waiting for St to drop a rewritten cover from its texture cache
const ALBUM_ART_RELOAD_TIMEOUT_MS = 500;
// Covers are read into the shell's memory, and players choose what artUrl points at
const ALBUM_ART_MAX_BYTES = 20 * 1024 * 1024;
// Browsers hand over 150px covers, which look soft stretched across the dropdown;
// anything under this size is worth looking for a sharper copy of
const ALBUM_ART_SHARP_SIZE = 300;
const ALBUM_ART_SMALL_MAX_BYTES = 300 * 1024;
const ITUNES_SEARCH_URL = 'https://itunes.apple.com/search';
const ITUNES_ART_SIZE = '600x600bb';

// Older Spotify builds report a dead open.spotify.com host for the same image
function normalizeAlbumArtUrl(artUrl) {
    return artUrl?.replace('https://open.spotify.com/image/', 'https://i.scdn.co/image/') || null;
}

function isSmallCover(bytes) {
    // A file this big isn't a small image, and decoding it would stall the shell
    if (bytes.get_size() > ALBUM_ART_SMALL_MAX_BYTES) {
        return false;
    }
    try {
        const loader = new GdkPixbuf.PixbufLoader();
        loader.write_bytes(bytes);
        loader.close();
        const pixbuf = loader.get_pixbuf();
        return Math.min(pixbuf.get_width(), pixbuf.get_height()) < ALBUM_ART_SHARP_SIZE;
    } catch (e) {
        return false;
    }
}

// Lowercased with "(feat. ...)" style suffixes and punctuation gone, so J-Star matches Jstar
function normalizeMatchText(text) {
    return (text ?? '').toLowerCase()
        .replace(/[([].*?[)\]]/g, '')
        .replace(/[^\p{L}\p{N}]/gu, '');
}

// A wrong cover is worse than a soft one. Title and artist must match, and since a
// remix or cover version can share those, the album or the length has to confirm it.
function findMatchingRelease(results, track) {
    const title = normalizeMatchText(track.title);
    const artist = normalizeMatchText(track.artist);
    const album = normalizeMatchText(track.album);
    if (!title || !artist) {
        return null;
    }

    const matches = results.filter(result => {
        const resultArtist = normalizeMatchText(result.artistName);
        return result.artworkUrl100 && resultArtist &&
            normalizeMatchText(result.trackName) === title &&
            (resultArtist.includes(artist) || artist.includes(resultArtist));
    });

    const sameAlbum = album && matches.find(result => normalizeMatchText(result.collectionName) === album);
    if (sameAlbum) {
        return sameAlbum;
    }

    const lengthGap = result => Math.abs(result.trackTimeMillis / 1000 - track.duration);
    return matches
        .filter(result => track.duration > 0 && lengthGap(result) <= LYRICS_DURATION_TOLERANCE_S)
        .sort((a, b) => lengthGap(a) - lengthGap(b))[0] ?? null;
}

// iTunes catalogs differ by country and many songs are in only one, so start with
// where the machine is (the timezone is a better hint than a language like en_US)
function itunesCountries() {
    const countries = [];
    try {
        const timezone = GLib.TimeZone.new_local().get_identifier();
        const [, contents] = GLib.file_get_contents('/usr/share/zoneinfo/zone.tab');
        const zone = new TextDecoder().decode(contents).split('\n')
            .find(line => line.split('\t')[2] === timezone);
        if (zone) {
            countries.push(zone.slice(0, 2));
        }
    } catch (e) {
        // Not every system has the file; the language and US below still work
    }
    const language = GLib.get_language_names()[0]?.match(/_([A-Z]{2})/)?.[1];
    return [...new Set([...countries, language, 'US'].filter(Boolean))];
}

// Widget that can be made as tall as it is wide, for the album art card
const SquareWidget = GObject.registerClass(
    class SquareWidget extends St.Widget {
        setSquare(square) {
            this._square = square;
            this.queue_relayout();
        }

        vfunc_get_preferred_height(forWidth) {
            if (!this._square || forWidth < 0) {
                return super.vfunc_get_preferred_height(forWidth);
            }
            return [forWidth, forWidth];
        }
    });

function newVerticalBox(params) {
    const box = new St.BoxLayout(params);
    if ('orientation' in box) {
        box.orientation = Clutter.Orientation.VERTICAL;
    } else {
        box.vertical = true;
    }
    return box;
}

// Helper function to check if a bus name is a supported music player
function isSupportedPlayer(busName) {
    // Desktop apps
    if (busName === 'org.mpris.MediaPlayer2.spotify' ||
        busName === 'org.mpris.MediaPlayer2.youtube-music') {
        return true;
    }

    // Browser-based players (chromium, chrome, firefox, etc.)
    // These have instance IDs like: org.mpris.MediaPlayer2.chromium.instance12345
    // or, for the Firefox snap: org.mpris.MediaPlayer2.firefox.instance_1_42
    return /^org\.mpris\.MediaPlayer2\.(chromium|chrome|firefox|brave|edge)\.instance[\w.]+$/.test(busName);
}

// Promise wrapper around Gio.DBusProxy.new_for_bus so we never block the shell
function newProxyAsync(busName, iface) {
    return new Promise((resolve, reject) => {
        Gio.DBusProxy.new_for_bus(
            Gio.BusType.SESSION,
            Gio.DBusProxyFlags.NONE,
            null,
            busName,
            MPRIS_PLAYER_PATH,
            iface,
            null,
            (source, result) => {
                try {
                    resolve(Gio.DBusProxy.new_for_bus_finish(result));
                } catch (e) {
                    reject(e);
                }
            }
        );
    });
}

// Promise wrapper around Gio.DBusProxy.call
function callAsync(proxy, method, params = null, timeout = -1) {
    return new Promise((resolve, reject) => {
        proxy.call(method, params, Gio.DBusCallFlags.NONE, timeout, null, (p, result) => {
            try {
                resolve(p.call_finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
}

const MusicLyricsIndicator = GObject.registerClass(
    class MusicLyricsIndicator extends PanelMenu.Button {
        _init(settings) {
            super._init(0.5, 'Music Lyrics Indicator');

            this._settings = settings;

            // Create a box to hold the label
            const box = new St.BoxLayout({
                style_class: 'panel-status-menu-box'
            });

            this._label = new St.Label({
                text: 'No music playing',
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'spotify-lyrics-label'
            });

            // Fixed width so the indicator never shifts between lines; lines too long for
            // it shrink (see _fitLabelFont), then ellipsize
            this._labelWidth = LABEL_DEFAULT_WIDTH_PX;
            this._label.set_width(this._labelWidth);
            this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            this._label.connect('notify::mapped', () => this._fitLabelFont());

            box.add_child(this._label);
            this.add_child(box);

            this._currentTrack = null;
            this._currentLyrics = null;
            this._currentLine = '';
            this._lyricsCache = new Map();
            this._lyricsCacheDir = GLib.build_filenamev([
                GLib.get_user_cache_dir(),
                'spotline',
                'lyrics-v1'
            ]);
            this._albumArtDir = GLib.build_filenamev([
                GLib.get_user_cache_dir(),
                'spotline',
                'album-art'
            ]);
            this._albumArtUrl = null;
            this._albumArtSourceUrl = null;
            this._smallArtSourceUrl = null;
            // Sharper cover URL per track, or null when there isn't one
            this._sharperArtUrls = new Map();
            this._durationPending = false;
            this._albumArtReady = false;
            this._showAlbumArt = this._settings.get_boolean('show-album-art');
            this._albumArtExpanded = false;
            this._pendingArtSwap = null;
            this._pendingFades = new Map();
            this._labelTarget = null;
            this._trackInfoTarget = null;

            // St caches background images for the whole session and only drops one
            // when its file changes, so covers rotate through two fixed files
            this._textureFileChangedId = St.TextureCache.get_default().connect(
                'texture-file-changed',
                (cache, file) => {
                    if (this._pendingArtSwap?.file.equal(file)) {
                        this._finishArtSwap();
                    }
                }
            );
            this._proxy = null;
            this._propertiesChangedId = null;
            this._lyricsTimeoutId = null;
            this._playerProxy = null;
            this._currentBusName = null;
            this._findGeneration = 0;
            this._lastPruneTime = 0;
            this._dbusProxy = null;
            this._nameOwnerChangedId = null;
            this._propertiesSubscriptionId = null;

            this._soupSession = new Soup.Session();
            this._soupSession.user_agent = 'Spotline GNOME Extension/1.0';

            this._showLyrics = this._settings.get_boolean('show-lyrics');
            this._isDestroyed = false;
            this._lyricsOffset = this._settings.get_int('lyrics-offset');

            // Connect setting signals
            this._offsetSignalId = this._settings.connect('changed::lyrics-offset', () => {
                this._lyricsOffset = this._settings.get_int('lyrics-offset');
            });

            // Toggles and actions that live in the extension's preferences
            this._prefsSignalIds = [
                this._settings.connect('changed::show-lyrics', () => {
                    this._showLyrics = this._settings.get_boolean('show-lyrics');
                    if (!this._showLyrics) {
                        this._clearLyrics();
                    }
                    this._updateTrackInfo(true);
                }),
                this._settings.connect('changed::show-album-art', () => {
                    this._showAlbumArt = this._settings.get_boolean('show-album-art');
                    this._syncAlbumArt();
                }),
                this._settings.connect('changed::sharper-album-art', () => {
                    this._updateTrackInfo();
                }),
                this._settings.connect('changed::refresh-player-request', () => {
                    this._findActivePlayer();
                })
            ];

            this.menu.box.add_style_class_name('spotline-menu');
            // Pin the dropdown to the indicator's width so it spans the whole
            // top-bar pill and never resizes with the track name
            this.connect('notify::width', () => this._syncMenuWidth());
            this._buildMenu();
            this._initLyricsCacheDirectory();
            this._setupDBusMonitoring();
        }

        _buildMenu() {
            // The whole dropdown is one card. With album art the cover fills all of
            // it, edge to edge, and everything else sits on top; without, it is a
            // plain compact layout.
            const cardItem = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
                style_class: 'spotline-card-item'
            });
            // (HIDDEN is missing on older shells, where the item has no ornament slot)
            if (PopupMenu.Ornament.HIDDEN !== undefined) {
                cardItem.setOrnament(PopupMenu.Ornament.HIDDEN);
            }
            const card = this._card = new SquareWidget({
                style_class: 'spotline-card',
                layout_manager: new Clutter.BinLayout(),
                x_expand: true,
                clip_to_allocation: true
            });
            cardItem.add_child(card);
            this.menu.addMenuItem(cardItem);

            // Cover, in two slots so a new one can fade in over the old one, and
            // shades that keep the text on top of it readable
            this._coverLayer = new St.Widget({
                layout_manager: new Clutter.BinLayout(),
                x_expand: true,
                y_expand: true,
                visible: false
            });
            this._albumArtSlots = [0, 1].map(i => {
                const widget = new St.Widget({
                    style_class: 'spotline-album-art',
                    x_expand: true,
                    y_expand: true,
                    opacity: 0
                });
                this._coverLayer.add_child(widget);
                return {
                    widget,
                    file: Gio.File.new_for_path(GLib.build_filenamev([this._albumArtDir, `cover-${i}.jpg`]))
                };
            });
            this._albumArtFront = 0;
            this._artLyricsShade = new St.Widget({
                style_class: 'spotline-art-lyrics-shade',
                x_expand: true,
                y_expand: true,
                y_align: Clutter.ActorAlign.START,
                visible: false
            });
            const bottomShade = new St.Widget({
                style_class: 'spotline-cover-bottom-shade',
                x_expand: true,
                y_expand: true,
                y_align: Clutter.ActorAlign.END
            });
            this._coverLayer.add_child(this._artLyricsShade);
            this._coverLayer.add_child(bottomShade);
            card.add_child(this._coverLayer);
            card.connect('notify::width', () => {
                this._artLyricsShade.height = Math.round(card.width * 0.42);
                bottomShade.height = Math.round(card.width * 0.65);
            });
            // From the allocation, as width reports the natural size while a layout is pending
            card.connect('notify::allocation', () => this._scaleCardControls(card.allocation.get_width()));

            // Upcoming lyric at the top of the cover (the current one is in the
            // top bar); on each new line it slides up out of the cover, towards the bar
            this._artLyricsBox = new St.Widget({
                style_class: 'spotline-art-lyrics',
                layout_manager: new Clutter.BinLayout(),
                x_expand: true,
                y_expand: true,
                clip_to_allocation: true,
                visible: false
            });
            // Two overlapping rows so the outgoing line can leave as the new one arrives
            this._artLyricRows = [0, 1].map(() => {
                const label = new St.Label({
                    style_class: 'spotline-art-lyric',
                    x_expand: true,
                    y_expand: true,
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.START
                });
                label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
                label.clutter_text.line_wrap = true;
                label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
                label.clutter_text.line_alignment = Pango.Alignment.CENTER;
                this._artLyricsBox.add_child(label);
                return label;
            });
            this._artLyricFront = 0;
            this._artLyricsActive = false;
            card.add_child(this._artLyricsBox);

            // Track info and playback controls, along the bottom of the card
            const content = newVerticalBox({
                style_class: 'spotline-card-content',
                x_expand: true,
                y_expand: true,
                y_align: Clutter.ActorAlign.END
            });

            const trackTextBox = this._trackTextBox = newVerticalBox({x_expand: true});
            this._trackTitleLabel = new St.Label({style_class: 'spotline-track-title'});
            this._trackArtistLabel = new St.Label({style_class: 'spotline-track-artist'});
            for (const label of [this._trackTitleLabel, this._trackArtistLabel]) {
                // Wrap long names inside the fixed-width menu instead of widening it
                label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
                label.clutter_text.line_wrap = true;
                label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
                trackTextBox.add_child(label);
            }
            content.add_child(trackTextBox);
            this._setTrackInfo('No track playing');

            const controlsBox = new St.BoxLayout({
                style_class: 'spotline-controls',
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER
            });

            const makeControlButton = (iconName, action) => {
                const button = new St.Button({
                    style_class: 'spotline-control',
                    reactive: true,
                    can_focus: true,
                    track_hover: true,
                    child: new St.Icon({
                        icon_name: iconName,
                        icon_size: 20
                    })
                });
                button.connect('clicked', () => this._controlPlayback(action));
                return button;
            };

            const prevButton = makeControlButton('media-skip-backward-symbolic', 'Previous');
            const playPauseButton = makeControlButton('media-playback-start-symbolic', 'PlayPause');
            const nextButton = makeControlButton('media-skip-forward-symbolic', 'Next');
            this._prevButton = prevButton;
            this._playPauseButton = playPauseButton;
            this._nextButton = nextButton;

            controlsBox.add_child(prevButton);
            controlsBox.add_child(playPauseButton);
            controlsBox.add_child(nextButton);
            content.add_child(controlsBox);

            card.add_child(content);
            this._controlsBox = controlsBox;
            this._cardContent = content;
        }

        // Scales the track title, artist, playback buttons and the padding and spacing
        // around them (not the upcoming lyric) with the card's width
        _scaleCardControls(width) {
            const scale = Math.max(1, width / CARD_BASE_WIDTH_PX);
            const percent = Math.round(scale * 100);
            if (percent === this._cardControlsPercent) {
                return;
            }
            this._cardControlsPercent = percent;
            const base = percent === 100;
            const px = v => `${Math.round(v * scale)}px`;

            // Title and artist inherit the box's font, so a percentage scales them from
            // the theme's size
            this._trackTextBox.style = base ? null : `font-size: ${percent}%;`;
            // Spacing, padding and icon size mirror stylesheet.css and makeControlButton.
            // The margins grow with the card and the gap above the buttons a bit more,
            // so the larger title and buttons don't crowd each other or the edges.
            this._cardContent.style = base ? null
                : `padding: ${px(14)} ${px(18)} ${px(16)}; spacing: ${px(16)};`;
            this._controlsBox.style = base ? null : `spacing: ${px(12)};`;
            for (const button of [this._prevButton, this._playPauseButton, this._nextButton]) {
                button.style = base ? null : `padding: ${px(8)} ${px(22)};`;
                button.child.icon_size = Math.round(20 * scale);
            }
        }

        _controlPlayback(action) {
            if (!this._playerProxy) {
                this._findActivePlayer();
                return;
            }

            // Flip the icon right away instead of waiting for the player's PropertiesChanged round trip
            if (action === 'PlayPause') {
                this._playPauseButton.child.icon_name = this._isCurrentlyPlaying()
                    ? 'media-playback-start-symbolic'
                    : 'media-playback-pause-symbolic';
            }

            callAsync(this._playerProxy, action).catch(e => {
                logError(e, `Failed to execute ${action}`);
                this._updatePlayPauseButton();
            });
        }

        _getCachedBool(name, fallback = true) {
            const value = this._playerProxy?.get_cached_property(name);
            return value ? value.unpack() : fallback;
        }

        _updatePlayPauseButton() {
            if (!this._playPauseButton) {
                return;
            }

            if (!this._playerProxy) {
                this._playPauseButton.child.icon_name = 'media-playback-start-symbolic';
                this._prevButton.reactive = false;
                this._nextButton.reactive = false;
                return;
            }

            try {
                const playbackStatus = this._playerProxy.get_cached_property('PlaybackStatus');
                if (playbackStatus) {
                    const status = playbackStatus.unpack();
                    const icon = status === 'Playing' ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
                    this._playPauseButton.child.icon_name = icon;
                }

                // Grey out skip buttons when the player reports it can't skip
                this._prevButton.reactive = this._getCachedBool('CanGoPrevious');
                this._nextButton.reactive = this._getCachedBool('CanGoNext');
                this._prevButton.opacity = this._prevButton.reactive ? 255 : 100;
                this._nextButton.opacity = this._nextButton.reactive ? 255 : 100;
            } catch (e) {
                logError(e, 'Failed to update playback controls');
            }
        }

        _isCurrentlyPlaying() {
            const status = this._playerProxy?.get_cached_property('PlaybackStatus');
            return status ? status.unpack() === 'Playing' : true;
        }

        _setupDBusMonitoring() {
            try {
                this._dbusProxy = Gio.DBusProxy.new_for_bus_sync(
                    Gio.BusType.SESSION,
                    Gio.DBusProxyFlags.NONE,
                    null,
                    'org.freedesktop.DBus',
                    '/org/freedesktop/DBus',
                    'org.freedesktop.DBus',
                    null
                );

                this._nameOwnerChangedId = this._dbusProxy.connect('g-signal', (proxy, senderName, signalName, parameters) => {
                    if (signalName === 'NameOwnerChanged') {
                        const [name, oldOwner, newOwner] = parameters.deep_unpack();
                        if (name.startsWith('org.mpris.MediaPlayer2.')) {
                            // Our player went away: drop it so we stop polling a dead name
                            if (name === this._currentBusName && !newOwner) {
                                this._disconnectPlayer();
                            }
                            this._findActivePlayer();
                        }
                    }
                });

                // Watch for PropertiesChanged from any MPRIS player
                const connection = Gio.bus_get_sync(Gio.BusType.SESSION, null);
                this._propertiesSubscriptionId = connection.signal_subscribe(
                    null,
                    'org.freedesktop.DBus.Properties',
                    'PropertiesChanged',
                    MPRIS_PLAYER_PATH,
                    null,
                    Gio.DBusSignalFlags.NONE,
                    (conn, sender, path, iface, signal, parameters) => {
                        try {
                            const [changedIface, changedProps] = parameters.deep_unpack();
                            if (changedIface === MPRIS_PLAYER_INTERFACE) {
                                // If playback status changes to Playing on any player, re-evaluate
                                if (changedProps['PlaybackStatus']) {
                                    const status = changedProps['PlaybackStatus'].deep_unpack();
                                    // Resuming the player we're already on needs no rescan
                                    if (status === 'Playing' && sender !== this._playerProxy?.g_name_owner) {
                                        this._findActivePlayer();
                                    }
                                }
                            }
                        } catch (e) {
                            // Ignore unpacking errors
                        }
                    }
                );
            } catch (e) {
                logError(e, 'Failed to setup DBus monitoring');
            }

            this._findActivePlayer();
        }

        async _findActivePlayer() {
            // Only the most recent search is allowed to switch players
            const generation = ++this._findGeneration;

            try {
                const reply = await callAsync(this._dbusProxy, 'ListNames');
                if (this._isDestroyed || generation !== this._findGeneration) return;

                const names = reply.get_child_value(0).deep_unpack().filter(isSupportedPlayer);

                // Prefer a player that is actually playing
                const statuses = await Promise.all(names.map(name => this._getPlaybackStatus(name)));
                if (this._isDestroyed || generation !== this._findGeneration) return;

                const playingIndex = statuses.indexOf('Playing');
                let foundPlayer = playingIndex >= 0 ? names[playingIndex] : null;

                // Otherwise stay on the current player if it's still around, else take any
                if (!foundPlayer) {
                    foundPlayer = names.includes(this._currentBusName)
                        ? this._currentBusName
                        : names[0] ?? null;
                }

                if (foundPlayer) {
                    await this._tryConnectToPlayer(foundPlayer, generation);
                } else {
                    this._disconnectPlayer();
                    this._updateLabelText('No music playing');
                }
            } catch (e) {
                logError(e, 'Failed to find active player');
            }
        }

        async _getPlaybackStatus(busName) {
            try {
                const reply = await new Promise((resolve, reject) => {
                    Gio.DBus.session.call(
                        busName,
                        MPRIS_PLAYER_PATH,
                        'org.freedesktop.DBus.Properties',
                        'Get',
                        new GLib.Variant('(ss)', [MPRIS_PLAYER_INTERFACE, 'PlaybackStatus']),
                        null,
                        Gio.DBusCallFlags.NONE,
                        1000,
                        null,
                        (conn, result) => {
                            try {
                                resolve(conn.call_finish(result));
                            } catch (e) {
                                reject(e);
                            }
                        }
                    );
                });
                return reply.get_child_value(0).get_variant().unpack();
            } catch (e) {
                // Player might not be available
                return null;
            }
        }

        _disconnectPlayer() {
            if (this._lyricsTimeoutId) {
                GLib.source_remove(this._lyricsTimeoutId);
                this._lyricsTimeoutId = null;
            }

            if (this._propertiesChangedId && this._playerProxy) {
                this._playerProxy.disconnect(this._propertiesChangedId);
            }
            this._propertiesChangedId = null;
            this._proxy = null;
            this._playerProxy = null;
            this._currentBusName = null;
            this._currentTrack = null;
            this._currentLyrics = null;
            this._currentLine = '';
            this._setArtLyrics(null);

            this._setTrackInfo('No track playing');
            this._updateAlbumArt(null);
            this._updatePlayPauseButton();
        }

        async _tryConnectToPlayer(busName, generation) {
            if (this._currentBusName === busName && this._playerProxy) {
                return true;
            }

            try {
                // Properties proxy (for Position) and player proxy (for metadata/controls)
                const [proxy, playerProxy] = await Promise.all([
                    newProxyAsync(busName, 'org.freedesktop.DBus.Properties'),
                    newProxyAsync(busName, MPRIS_PLAYER_INTERFACE)
                ]);
                if (this._isDestroyed || generation !== this._findGeneration) return false;

                this._disconnectPlayer();

                this._proxy = proxy;
                this._playerProxy = playerProxy;
                this._currentBusName = busName;

                this._propertiesChangedId = this._playerProxy.connect(
                    'g-properties-changed',
                    this._onPropertiesChanged.bind(this)
                );

                this._updatePlayPauseButton();
                this._updateTrackInfo();
                return true;
            } catch (e) {
                logError(e, `Failed to connect to ${busName}`);
                return false;
            }
        }

        _onPropertiesChanged(proxy, changed) {
            this._updateTrackInfo();
            this._updatePlayPauseButton();

            // Resync the lyric line right away on resume/seek instead of waiting for the next tick
            if (changed.lookup_value('PlaybackStatus', null)) {
                this._updateCurrentLyricLine();
            }
        }

        _updateTrackInfo(forceFetch = false) {
            if (!this._playerProxy) {
                return;
            }

            try {
                const metadata = this._playerProxy.get_cached_property('Metadata');
                if (!metadata) {
                    this._updateLabelText('No music playing');
                    this._setTrackInfo('No track playing');
                    this._updateAlbumArt(null);
                    return;
                }

                const metadataDict = metadata.deep_unpack();
                
                let title = 'Unknown Track';
                const titleVariant = metadataDict['xesam:title'];
                if (titleVariant) {
                    const unpackedTitle = titleVariant.deep_unpack();
                    title = Array.isArray(unpackedTitle) ? unpackedTitle[0] : unpackedTitle;
                }

                let artist = 'Unknown Artist';
                const artistVariant = metadataDict['xesam:artist'];
                if (artistVariant) {
                    const unpackedArtist = artistVariant.deep_unpack();
                    artist = Array.isArray(unpackedArtist) ? unpackedArtist[0] : unpackedArtist;
                }

                let album = 'Unknown Album';
                const albumVariant = metadataDict['xesam:album'];
                if (albumVariant) {
                    const unpackedAlbum = albumVariant.deep_unpack();
                    album = Array.isArray(unpackedAlbum) ? unpackedAlbum[0] : unpackedAlbum;
                }

                let duration = 0;
                // Browsers report the largest int64 until they know a new track's length
                let durationPending = false;
                const durationVariant = metadataDict['mpris:length'];
                if (durationVariant) {
                    const unpackedDuration = durationVariant.deep_unpack();
                    durationPending = unpackedDuration >= Number.MAX_SAFE_INTEGER;
                    if (!durationPending) {
                        duration = Math.round(unpackedDuration / 1000000); // Convert microseconds to seconds
                    }
                }

                const artUrl = normalizeAlbumArtUrl(metadataDict['mpris:artUrl']?.deep_unpack());

                // If both title and artist are missing, show icon or nothing. Browsers
                // send a track change as a burst of updates starting with just the new
                // cover, so this has to pass that on rather than dropping the art.
                if (title === 'Unknown Track' && artist === 'Unknown Artist') {
                    this._updateLabelText('♪');
                    this._setTrackInfo('Unknown track');
                    this._albumArtSourceUrl = artUrl;
                    this._updateAlbumArt(artUrl);
                    return;
                }

                this._albumArtSourceUrl = artUrl;
                const sharperArtUrl = artUrl && this._settings.get_boolean('sharper-album-art')
                    ? this._sharperArtUrls.get(this._getLyricsCacheKey(title, artist))
                    : null;
                this._updateAlbumArt(sharperArtUrl || artUrl);

                // Check if lyrics query inputs changed to avoid redundant API calls
                const lyricsQueryChanged = forceFetch ||
                                           !this._currentTrack ||
                                           this._currentTrack.title !== title ||
                                           this._currentTrack.artist !== artist ||
                                           this._lyricsLookupDeferred;

                this._currentTrack = {
                    title: title,
                    artist: artist,
                    album: album,
                    duration: duration
                };

                this._durationPending = durationPending;
                this._maybeFindSharperArt();

                // Update menu with track info
                this._setTrackInfo(this._currentTrack.title, this._currentTrack.artist);

                // Only fetch lyrics if the query inputs changed or it's forced
                if (lyricsQueryChanged) {
                    // Update label immediately with song info
                    this._updateLabelText(`${this._currentTrack.artist} - ${this._currentTrack.title}`);

                    // Try to fetch lyrics if enabled, waiting for the real length as
                    // the lookup would match nothing with the placeholder
                    this._lyricsLookupDeferred = this._showLyrics && durationPending;
                    if (this._lyricsLookupDeferred) {
                        this._clearLyrics();
                    } else if (this._showLyrics) {
                        this._fetchLyrics(this._currentTrack.title, this._currentTrack.artist, this._currentTrack.album, this._currentTrack.duration);
                    }
                } else if (!this._showLyrics) {
                    // If lyrics are disabled but track didn't change, make sure label is still correct
                    this._updateLabelText(`${this._currentTrack.artist} - ${this._currentTrack.title}`);
                }
            } catch (e) {
                logError(e, 'Failed to get track info');
            }
        }

        _setTrackInfo(title, artist = null) {
            const target = `${title}\n${artist ?? ''}`;
            if (target === this._trackInfoTarget) {
                return;
            }
            this._trackInfoTarget = target;

            this._crossfade(this._trackTextBox, () => {
                this._trackTitleLabel.text = title;
                this._trackArtistLabel.text = artist ?? '';
                this._trackArtistLabel.visible = !!artist;
            });
        }

        // Fades the actor out, applies the change and fades it back in. A change that
        // arrives mid-fade replaces the pending one, so rapid skips settle on the last.
        _crossfade(actor, apply) {
            actor.remove_all_transitions();

            if (!actor.mapped) {
                this._pendingFades.delete(actor);
                actor.opacity = 255;
                apply();
                return;
            }

            this._pendingFades.set(actor, apply);
            actor.ease({
                opacity: 0,
                duration: TEXT_FADE_OUT_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    this._pendingFades.get(actor)?.();
                    this._pendingFades.delete(actor);
                    actor.ease({
                        opacity: 255,
                        duration: TEXT_FADE_IN_MS,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD
                    });
                }
            });
        }

        _updateAlbumArt(url) {
            if (url === this._albumArtUrl) {
                return;
            }
            this._albumArtUrl = url;

            if (!url) {
                this._cancelArtSwap();
                this._albumArtReady = false;
                this._syncAlbumArt();
                return;
            }

            // Browsers and local players hand over a file, Spotify a web URL and
            // some players (mpv) embed the image in a data URI
            this._loadAlbumArtBytes(url).then(bytes => {
                if (this._isDestroyed || url !== this._albumArtUrl) {
                    return;
                }
                if (!bytes?.get_size()) {
                    throw new Error('Album art is empty');
                }
                this._queueArtSwap(bytes);

                if (url === this._albumArtSourceUrl && isSmallCover(bytes)) {
                    this._smallArtSourceUrl = url;
                    this._maybeFindSharperArt();
                }
            }).catch(e => {
                if (this._isDestroyed || url !== this._albumArtUrl) {
                    return;
                }
                logError(e, 'Failed to load album art');

                // A sharper copy that won't load is no reason to lose the player's own
                if (this._albumArtSourceUrl && url !== this._albumArtSourceUrl && this._currentTrack) {
                    const {title, artist} = this._currentTrack;
                    this._sharperArtUrls.set(this._getLyricsCacheKey(title, artist), null);
                    this._updateAlbumArt(this._albumArtSourceUrl);
                    return;
                }

                // Better no cover than the previous song's
                this._cancelArtSwap();
                this._albumArtReady = false;
                this._syncAlbumArt();
            });
        }

        // Runs from both the metadata and the cover loading, as a browser's track
        // change only has the small cover and the track's details after a moment
        _maybeFindSharperArt() {
            const track = this._currentTrack;
            if (!track || this._durationPending || !this._albumArtSourceUrl ||
                this._smallArtSourceUrl !== this._albumArtSourceUrl ||
                !this._settings.get_boolean('sharper-album-art')) {
                return;
            }

            const key = this._getLyricsCacheKey(track.title, track.artist);
            if (this._sharperArtUrls.has(key)) {
                return;
            }
            this._sharperArtUrls.set(key, null);

            const isStillCurrent = () => !this._isDestroyed && this._currentTrack &&
                this._getLyricsCacheKey(this._currentTrack.title, this._currentTrack.artist) === key;

            this._lookupSharperArt(track).then(url => {
                if (this._isDestroyed || !url) {
                    return;
                }
                this._sharperArtUrls.set(key, url);
                if (isStillCurrent() && this._albumArtSourceUrl &&
                    this._settings.get_boolean('sharper-album-art')) {
                    this._updateAlbumArt(url);
                }
            }).catch(e => {
                if (this._isDestroyed) {
                    return;
                }
                // Probably offline: let the next play of this track try again
                this._sharperArtUrls.delete(key);
                logError(e, 'Failed to look up sharper album art');
            });
        }

        async _lookupSharperArt(track) {
            this._itunesCountries ??= itunesCountries();
            for (const country of this._itunesCountries) {
                // eslint-disable-next-line no-await-in-loop
                const data = await this._requestJson(ITUNES_SEARCH_URL, {
                    term: `${track.artist} ${track.title}`,
                    entity: 'song',
                    limit: 25,
                    country
                });
                const release = findMatchingRelease(data?.results ?? [], track);
                if (release) {
                    return release.artworkUrl100.replace(/\/\d+x\d+bb/, `/${ITUNES_ART_SIZE}`);
                }
            }
            return null;
        }

        async _loadAlbumArtBytes(url) {
            if (url.startsWith('file://')) {
                return this._readAlbumArtFile(url);
            }
            if (url.startsWith('http://') || url.startsWith('https://')) {
                return this._downloadAlbumArt(url);
            }
            if (url.startsWith('data:')) {
                return Soup.uri_decode_data_uri(url)[0];
            }
            throw new Error(`Unsupported album art URL: ${url.slice(0, 40)}`);
        }

        _readAlbumArtFile(url) {
            const file = Gio.File.new_for_uri(url);
            return new Promise((resolve, reject) => {
                file.query_info_async('standard::type,standard::size', Gio.FileQueryInfoFlags.NONE,
                    GLib.PRIORITY_DEFAULT, null, (source, infoResult) => {
                        try {
                            // Regular files only: reading a device could never finish
                            const info = source.query_info_finish(infoResult);
                            if (info.get_file_type() !== Gio.FileType.REGULAR ||
                                info.get_size() > ALBUM_ART_MAX_BYTES) {
                                throw new Error('Album art file is not a usable size or type');
                            }
                        } catch (e) {
                            reject(e);
                            return;
                        }
                        source.load_bytes_async(null, (loaded, loadResult) => {
                            try {
                                resolve(loaded.load_bytes_finish(loadResult)[0]);
                            } catch (e) {
                                reject(e);
                            }
                        });
                    });
            });
        }

        _downloadAlbumArt(url) {
            const msg = Soup.Message.new('GET', url);
            const cancellable = new Gio.Cancellable();
            msg.connect('got-headers', () => {
                if (msg.get_response_headers().get_content_length() > ALBUM_ART_MAX_BYTES) {
                    cancellable.cancel();
                }
            });
            return new Promise((resolve, reject) => {
                this._soupSession.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (session, result) => {
                    try {
                        const bytes = session.send_and_read_finish(result);
                        if (msg.get_status() !== Soup.Status.OK) {
                            throw new Error(`Album art request returned ${msg.get_status()}`);
                        }
                        resolve(bytes);
                    } catch (e) {
                        reject(e);
                    }
                });
            });
        }

        // Writes the cover into the hidden slot's file, then waits for St to reload it
        _queueArtSwap(bytes) {
            this._cancelArtSwap();

            const back = this._albumArtSlots[1 - this._albumArtFront];
            try {
                // Written in place (not via a temp file and rename) so St's file
                // monitor sees the change and evicts the old texture
                GLib.file_set_contents_full(back.file.get_path(), bytes.get_data(),
                    GLib.FileSetContentsFlags.NONE, 0o600);
            } catch (e) {
                logError(e, 'Failed to save album art');
                return;
            }
            back.widget.style = `background-image: url("${back.file.get_uri()}");`;

            // A file St never loaded has no monitor, so the signal may never come
            this._pendingArtSwap = {
                file: back.file,
                timeoutId: GLib.timeout_add(GLib.PRIORITY_DEFAULT, ALBUM_ART_RELOAD_TIMEOUT_MS, () => {
                    this._pendingArtSwap.timeoutId = 0;
                    this._finishArtSwap();
                    return GLib.SOURCE_REMOVE;
                })
            };
        }

        _finishArtSwap() {
            this._cancelArtSwap();

            const front = this._albumArtSlots[this._albumArtFront];
            this._albumArtFront = 1 - this._albumArtFront;
            const back = this._albumArtSlots[this._albumArtFront];

            front.widget.remove_all_transitions();
            back.widget.remove_all_transitions();
            // Above the old cover but still under the lyrics overlay
            back.widget.get_parent().set_child_below_sibling(back.widget, this._artLyricsShade);

            if (this._albumArtExpanded && this.menu.isOpen) {
                // Fade the new cover in over the old one, which stays opaque underneath
                back.widget.opacity = 0;
                back.widget.ease({
                    opacity: 255,
                    duration: ALBUM_ART_CROSSFADE_MS,
                    mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
                    onComplete: () => {
                        front.widget.opacity = 0;
                    }
                });
            } else {
                back.widget.opacity = 255;
                front.widget.opacity = 0;
            }

            this._albumArtReady = true;
            this._syncAlbumArt();
        }

        _cancelArtSwap() {
            if (this._pendingArtSwap?.timeoutId) {
                GLib.source_remove(this._pendingArtSwap.timeoutId);
            }
            this._pendingArtSwap = null;
        }

        _syncAlbumArt() {
            this._setAlbumArtExpanded(this._albumArtReady && this._showAlbumArt);
        }

        // Grows the card into the square cover (or back to the compact layout)
        // while the menu is open, otherwise snaps
        _setAlbumArtExpanded(expanded) {
            if (expanded === this._albumArtExpanded) {
                return;
            }
            this._albumArtExpanded = expanded;

            const card = this._card;
            const cover = this._coverLayer;
            card.remove_all_transitions();
            cover.remove_all_transitions();
            this._syncArtLyricsVisible();

            if (!this.menu.isOpen) {
                card.setSquare(expanded);
                card.set_height(-1);
                cover.opacity = 255;
                cover.visible = expanded;
                return;
            }

            // From the allocation, as width and height report natural sizes while a
            // layout is pending, such as just after the track's title has changed
            const startHeight = card.allocation.get_height();
            card.setSquare(expanded);
            const [, endHeight] = card.get_preferred_height(card.allocation.get_width());
            card.height = startHeight;

            const params = {
                duration: 250,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD
            };
            card.ease({...params, height: endHeight, onComplete: () => card.set_height(-1)});
            if (expanded) {
                cover.opacity = 0;
                cover.show();
            }
            cover.ease({
                ...params,
                opacity: expanded ? 255 : 0,
                onComplete: () => {
                    cover.visible = this._albumArtExpanded;
                    cover.opacity = 255;
                }
            });
        }

        // The upcoming lyric only shows on top of the cover
        _syncArtLyricsVisible() {
            this._artLyricsBox.visible = this._artLyricsShade.visible =
                this._artLyricsActive && this._albumArtExpanded;
        }

        _clearLyrics() {
            // Clear any existing lyrics timeout
            if (this._lyricsTimeoutId) {
                GLib.source_remove(this._lyricsTimeoutId);
                this._lyricsTimeoutId = null;
            }

            // Clear previous lyrics state
            this._currentLyrics = null;
            this._currentLine = '';
            this._setArtLyrics(null);
        }

        _fetchLyrics(title, artist, album, duration) {
            this._clearLyrics();

            const cacheKey = this._getLyricsCacheKey(title, artist);
            const cachedLyrics = this._lyricsCache.get(cacheKey);
            if (cachedLyrics) {
                this._touchLyricsDiskCache(cacheKey, cachedLyrics);
                this._displayLyricsResult(cachedLyrics, title, artist);
                return;
            }

            const diskCachedLyrics = this._readLyricsFromDiskCache(cacheKey);
            if (diskCachedLyrics) {
                this._lyricsCache.set(cacheKey, diskCachedLyrics);
                this._touchLyricsDiskCache(cacheKey, diskCachedLyrics);
                this._displayLyricsResult(diskCachedLyrics, title, artist);
                return;
            }

            const isStillCurrent = () => !this._isDestroyed &&
                this._currentTrack &&
                this._currentTrack.title === title &&
                this._currentTrack.artist === artist;

            this._lookupLyrics(title, artist, album, duration, isStillCurrent).then(data => {
                if (!isStillCurrent()) return;

                if (!data) {
                    this._updateLabelText(`${artist} - ${title}`);
                    return;
                }

                const lyricsResult = {
                    syncedLines: data.syncedLyrics ? this._parseLRC(data.syncedLyrics) : null,
                    plainFirstLine: data.plainLyrics ? data.plainLyrics.split('\n')[0] : null,
                    frequency: 1
                };

                this._lyricsCache.set(cacheKey, lyricsResult);
                this._writeLyricsToDiskCache(cacheKey, lyricsResult);
                this._displayLyricsResult(lyricsResult, title, artist);
            }).catch(e => {
                if (!isStillCurrent()) return;
                logError(e, 'Failed to fetch lyrics');
                this._updateLabelText(`${artist} - ${title}`);
            });
        }

        // lrclib's /get endpoint needs an exact match on every field, and players often
        // report only the first artist or a slightly different album name. Try the
        // strict lookup first, then progressively looser ones.
        async _lookupLyrics(title, artist, album, duration, isStillCurrent) {
            const hasLyrics = data => data && (data.syncedLyrics || data.plainLyrics);
            const params = {artist_name: artist, track_name: title};
            if (duration > 0) {
                params.duration = duration;
            }

            const attempts = [];
            if (album && album !== 'Unknown Album') {
                attempts.push({...params, album_name: album});
            }
            attempts.push(params);

            for (const query of attempts) {
                // eslint-disable-next-line no-await-in-loop
                const data = await this._requestJson(LYRICS_API_URL, query);
                if (!isStillCurrent()) return null;
                if (hasLyrics(data)) {
                    return data;
                }
            }

            // Last resort: fuzzy search, preferring synced lyrics with the closest duration
            const results = await this._requestJson(LYRICS_SEARCH_URL, {artist_name: artist, track_name: title});
            if (!Array.isArray(results)) {
                return null;
            }

            const candidates = results.filter(r => hasLyrics(r) &&
                (!(duration > 0) || !r.duration || Math.abs(r.duration - duration) <= LYRICS_DURATION_TOLERANCE_S));
            candidates.sort((a, b) => {
                if (!!a.syncedLyrics !== !!b.syncedLyrics) {
                    return a.syncedLyrics ? -1 : 1;
                }
                return Math.abs((a.duration || duration) - duration) - Math.abs((b.duration || duration) - duration);
            });

            return candidates[0] ?? null;
        }

        // Returns parsed JSON for a 200 response, null for anything else
        _requestJson(baseUrl, query) {
            const queryString = Object.entries(query)
                .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
                .join('&');
            const msg = Soup.Message.new('GET', `${baseUrl}?${queryString}`);

            return new Promise((resolve, reject) => {
                this._soupSession.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, result) => {
                    try {
                        const bytes = session.send_and_read_finish(result);
                        if (msg.get_status() !== Soup.Status.OK) {
                            resolve(null);
                            return;
                        }

                        const decoder = new TextDecoder('utf-8');
                        resolve(JSON.parse(decoder.decode(bytes.get_data())));
                    } catch (e) {
                        reject(e);
                    }
                });
            });
        }

        _getLyricsCacheKey(title, artist) {
            return `${this._normalizeLyricsCachePart(artist)}::${this._normalizeLyricsCachePart(title)}`;
        }

        _normalizeLyricsCachePart(value) {
            return value.trim().toLowerCase().replace(/\s+/g, ' ');
        }

        _initLyricsCacheDirectory() {
            try {
                GLib.mkdir_with_parents(this._lyricsCacheDir, 0o700);
                GLib.mkdir_with_parents(this._albumArtDir, 0o700);
            } catch (e) {
                logError(e, 'Failed to initialize lyrics cache');
            }
        }

        _getLyricsCachePath(cacheKey) {
            const fileName = `${GLib.compute_checksum_for_string(
                GLib.ChecksumType.SHA256,
                cacheKey,
                -1
            )}.json`;

            return GLib.build_filenamev([this._lyricsCacheDir, fileName]);
        }

        _readLyricsFromDiskCache(cacheKey) {
            try {
                const cachePath = this._getLyricsCachePath(cacheKey);
                const [success, contents] = GLib.file_get_contents(cachePath);
                if (!success) {
                    return null;
                }

                const decoder = new TextDecoder('utf-8');
                return this._deserializeLyricsResult(decoder.decode(contents));
            } catch (e) {
                return null;
            }
        }

        _touchLyricsDiskCache(cacheKey, lyricsResult) {
            lyricsResult.frequency = (lyricsResult.frequency || 1) + 1;
            // Rewriting an existing entry barely changes the cache size, so skip pruning
            this._writeLyricsToDiskCache(cacheKey, lyricsResult, false);
        }

        _writeLyricsToDiskCache(cacheKey, lyricsResult, shouldPrune = true) {
            try {
                this._initLyricsCacheDirectory();
                GLib.file_set_contents(
                    this._getLyricsCachePath(cacheKey),
                    this._serializeLyricsResult(lyricsResult)
                );
                if (shouldPrune) {
                    this._pruneLyricsCache();
                }
            } catch (e) {
                logError(e, 'Failed to write lyrics cache');
            }
        }

        _pruneLyricsCache() {
            // Scanning thousands of files is expensive; do it at most every 10 minutes
            const now = GLib.get_monotonic_time();
            if (now - this._lastPruneTime < LYRICS_CACHE_PRUNE_INTERVAL_US) {
                return;
            }
            this._lastPruneTime = now;

            try {
                const cacheDir = Gio.File.new_for_path(this._lyricsCacheDir);
                const enumerator = cacheDir.enumerate_children(
                    'standard::name,standard::size,time::modified',
                    Gio.FileQueryInfoFlags.NONE,
                    null
                );

                const entries = [];
                let totalBytes = 0;
                let info;

                while ((info = enumerator.next_file(null)) !== null) {
                    const name = info.get_name();
                    if (!name.endsWith('.json')) {
                        continue;
                    }

                    const path = GLib.build_filenamev([this._lyricsCacheDir, name]);
                    const size = info.get_size();
                    totalBytes += size;

                    entries.push({
                        path,
                        size,
                        modified: info.get_attribute_uint64('time::modified')
                    });
                }

                enumerator.close(null);

                if (totalBytes <= LYRICS_CACHE_MAX_BYTES) {
                    return;
                }

                // Only read each file's frequency once we know we have to evict
                for (const entry of entries) {
                    entry.frequency = this._readLyricsCacheFrequency(entry.path);
                }

                entries.sort((a, b) => {
                    if (a.frequency !== b.frequency) {
                        return a.frequency - b.frequency;
                    }
                    return a.modified - b.modified;
                });

                for (const entry of entries) {
                    if (totalBytes <= LYRICS_CACHE_MAX_BYTES) {
                        break;
                    }

                    try {
                        Gio.File.new_for_path(entry.path).delete(null);
                        totalBytes -= entry.size;
                    } catch (e) {
                        logError(e, 'Failed to prune lyrics cache entry');
                    }
                }
            } catch (e) {
                logError(e, 'Failed to prune lyrics cache');
            }
        }

        _readLyricsCacheFrequency(cachePath) {
            try {
                const [success, contents] = GLib.file_get_contents(cachePath);
                if (!success) {
                    return 0;
                }

                const decoder = new TextDecoder('utf-8');
                const payload = JSON.parse(decoder.decode(contents));
                return payload.f || 0;
            } catch (e) {
                return 0;
            }
        }

        _serializeLyricsResult(lyricsResult) {
            const payload = {
                v: 2,
                f: lyricsResult.frequency || 1
            };

            if (lyricsResult.syncedLines && lyricsResult.syncedLines.length > 0) {
                let previousTime = 0;
                payload.s = [];

                for (const line of lyricsResult.syncedLines) {
                    payload.s.push(line.time - previousTime, line.text);
                    previousTime = line.time;
                }
            } else if (lyricsResult.plainFirstLine) {
                payload.p = lyricsResult.plainFirstLine;
            }

            return JSON.stringify(payload);
        }

        _deserializeLyricsResult(serializedLyrics) {
            const payload = JSON.parse(serializedLyrics);
            if (payload.v !== 1 && payload.v !== 2) {
                return null;
            }

            if (payload.v === 1) {
                return {
                    syncedLines: Array.isArray(payload.s)
                        ? payload.s.map(line => ({ time: line[0], text: line[1] }))
                        : null,
                    plainFirstLine: payload.p || null,
                    frequency: payload.f || 1
                };
            }

            let runningTime = 0;
            const syncedLines = [];
            if (Array.isArray(payload.s)) {
                for (let i = 0; i < payload.s.length; i += 2) {
                    runningTime += payload.s[i];
                    syncedLines.push({
                        time: runningTime,
                        text: payload.s[i + 1]
                    });
                }
            }

            return {
                syncedLines: syncedLines.length > 0 ? syncedLines : null,
                plainFirstLine: payload.p || null,
                frequency: payload.f || 1
            };
        }

        _displayLyricsResult(lyricsResult, title, artist) {
            if (lyricsResult.syncedLines && lyricsResult.syncedLines.length > 0) {
                this._currentLyrics = lyricsResult.syncedLines;
                this._startLyricsDisplay();
            } else if (lyricsResult.plainFirstLine) {
                this._updateLabelText(lyricsResult.plainFirstLine);
            } else {
                this._updateLabelText(`${artist} - ${title}`);
            }
        }

        _trackLabelText() {
            const track = this._currentTrack;
            return track ? `${track.artist} - ${track.title}` : null;
        }

        _parseLRC(lrcText) {
            // Parse LRC format: [mm:ss.xx]lyrics
            const lines = [];
            const lrcLines = lrcText.split('\n');

            for (const line of lrcLines) {
                const match = line.match(/\[(\d+):(\d+)\.(\d+)\](.*)/);
                if (match) {
                    const minutes = parseInt(match[1]);
                    const seconds = parseInt(match[2]);
                    const centiseconds = parseInt(match[3]);
                    const text = match[4].trim();

                    const timeMs = (minutes * 60 + seconds) * 1000 + centiseconds * 10;

                    // Empty and "♪" lines mark instrumental stretches; keep them
                    // as empty gaps so the title shows there
                    lines.push({ time: timeMs, text: INSTRUMENTAL_LINE_RE.test(text) ? '' : text });
                }
            }

            return lines.sort((a, b) => a.time - b.time);
        }

        _startLyricsDisplay() {
            if (!this._currentLyrics || this._currentLyrics.length === 0) {
                return;
            }

            // Get current playback position
            this._updateCurrentLyricLine();

            // Update lyrics based on configured interval - use 200ms to minimize lag
            this._lyricsTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                // No need to poll the position while paused
                if (this._isCurrentlyPlaying()) {
                    this._updateCurrentLyricLine();
                }
                return GLib.SOURCE_CONTINUE;
            });
        }

        _updateCurrentLyricLine() {
            if (!this._proxy || !this._currentLyrics || this._currentLyrics.length === 0) {
                return;
            }

            try {
                // Query position via DBus
                this._proxy.call(
                    'Get',
                    new GLib.Variant('(ss)', [MPRIS_PLAYER_INTERFACE, 'Position']),
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null,
                    (proxy, result) => {
                        if (this._isDestroyed || proxy !== this._proxy || !this._currentLyrics) return;
                        try {
                            const reply = proxy.call_finish(result);
                            // Reply is a tuple containing a variant, extract the int64 value
                            const positionUs = reply.get_child_value(0).get_variant().get_int64();
                            // Convert microseconds to milliseconds and add user offset
                            const positionMs = (positionUs / 1000) + this._lyricsOffset;

                            // Find the current lyric line; the intro, gaps and an outro
                            // with no singing show the track title instead
                            const lines = this._currentLyrics;
                            let index = lines.length - 1;
                            while (index >= 0 && lines[index].time > positionMs) {
                                index--;
                            }

                            let sungLine = '';
                            if (index >= 0) {
                                const nextTime = index + 1 < lines.length ? lines[index + 1].time : Infinity;
                                const heldTooLong = nextTime - lines[index].time > LYRIC_LINE_MAX_MS &&
                                    positionMs - lines[index].time > LYRIC_LINE_MAX_MS;
                                sungLine = heldTooLong ? '' : lines[index].text;
                            }

                            let nextLine = '';
                            for (let i = index + 1; i < lines.length && !nextLine; i++) {
                                nextLine = lines[i].text;
                            }
                            this._setArtLyrics(sungLine || '♪', nextLine);

                            const currentLine = sungLine ||
                                (this._trackLabelText() ?? lines.find(line => line.text)?.text ?? '');

                            if (currentLine !== this._currentLine) {
                                this._currentLine = currentLine;
                                this._updateLabelText(currentLine);
                            }
                        } catch (e) {
                            logError(e, 'Failed to parse position');
                        }
                    }
                );
            } catch (e) {
                logError(e, 'Failed to update lyric line');
            }
        }

        // Shows the upcoming lyric over the album art (null hides it). When it
        // becomes the current line it slides up and away as the next one comes in.
        _setArtLyrics(current, next = '') {
            const box = this._artLyricsBox;
            const front = this._artLyricRows[this._artLyricFront];

            if (current === null) {
                this._artLyricsActive = false;
                this._syncArtLyricsVisible();
                this._finishArtLyricsScroll();
                for (const row of this._artLyricRows) {
                    row.text = '';
                }
                return;
            }
            this._artLyricsActive = true;
            this._syncArtLyricsVisible();

            if (next === front.text) {
                return;
            }

            // A plain change (seek, gap) crossfades; only an advance scrolls
            // (not mid-crossfade, whose pending update would overwrite the scroll)
            const scroll = box.mapped && !this._pendingFades.has(box) &&
                front.text !== '' && current === front.text;
            if (!scroll) {
                this._crossfade(box, () => {
                    this._finishArtLyricsScroll();
                    this._artLyricRows[this._artLyricFront].text = next;
                });
                return;
            }

            this._finishArtLyricsScroll();
            const outgoing = this._artLyricRows[this._artLyricFront];
            this._artLyricFront = 1 - this._artLyricFront;
            const incoming = this._artLyricRows[this._artLyricFront];
            incoming.text = next;

            const params = {
                duration: ART_LYRICS_SCROLL_MS,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC
            };
            const shift = outgoing.height;
            outgoing.ease({...params, translation_y: -shift, opacity: 0});
            incoming.translation_y = shift;
            incoming.opacity = 0;
            incoming.ease({...params, translation_y: 0, opacity: 255});
        }

        // Jumps an in-progress scroll to its end
        _finishArtLyricsScroll() {
            this._artLyricRows.forEach((row, i) => {
                row.remove_all_transitions();
                row.translation_y = 0;
                row.opacity = i === this._artLyricFront ? 255 : 0;
            });
        }

        _updateLabelText(text = null) {
            if (text !== null) {
                this._currentText = text;
            }

            const display = this._currentText || 'No music playing';
            if (display === this._labelTarget) {
                return;
            }
            this._labelTarget = display;
            this._crossfade(this._label, () => {
                this._label.set_text(display);
                this._fitLabelFont();
            });
        }

        get labelWidth() {
            return this._labelWidth;
        }

        // Width of the top-bar lyric, padding included
        setLabelWidth(width) {
            width = Math.round(width);
            if (width === this._labelWidth) {
                return;
            }
            this._labelWidth = width;
            this._label.set_width(width);
            this._fitLabelFont();
        }

        // Shrinks the font of a line too long for the label, down to a floor, so as
        // much of it as possible shows; whatever still doesn't fit is ellipsized
        _fitLabelFont() {
            const label = this._label;
            if (!label.mapped) {
                return;
            }
            label.style = null;
            label.ensure_style();
            const avail = this._labelWidth - label.get_theme_node().get_horizontal_padding();
            // The text's natural width is its full, unellipsized width
            const textWidth = () => label.clutter_text.get_preferred_width(-1)[1];

            const width = textWidth();
            if (width <= avail) {
                return;
            }
            // Text width scales about linearly with the font size; hinting can leave it
            // a hair over, so step down a little more until it fits
            let size = Math.floor(LABEL_FONT_PX * avail / width * 2) / 2;
            for (let i = 0; i < 4; i++) {
                size = Math.max(LABEL_MIN_FONT_PX, size);
                label.style = `font-size: ${size}px;`;
                label.ensure_style();
                if (size === LABEL_MIN_FONT_PX || textWidth() <= avail) {
                    break;
                }
                size -= 0.5;
            }
        }

        // The dropdown matches the pill, but its square cover must still fit on screen
        _syncMenuWidth() {
            const workArea = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
            const maxWidth = workArea ? workArea.height - 2 * MENU_SCREEN_MARGIN_PX : Infinity;
            this.menu.actor.width = Math.min(this.width, maxWidth);
        }

        destroy() {
            this._isDestroyed = true;

            if (this._offsetSignalId) {
                this._settings.disconnect(this._offsetSignalId);
                this._offsetSignalId = null;
            }

            for (const id of this._prefsSignalIds) {
                this._settings.disconnect(id);
            }
            this._prefsSignalIds = [];

            if (this._lyricsTimeoutId) {
                GLib.source_remove(this._lyricsTimeoutId);
                this._lyricsTimeoutId = null;
            }

            if (this._propertiesChangedId && this._playerProxy) {
                this._playerProxy.disconnect(this._propertiesChangedId);
                this._propertiesChangedId = null;
            }

            if (this._nameOwnerChangedId && this._dbusProxy) {
                this._dbusProxy.disconnect(this._nameOwnerChangedId);
                this._nameOwnerChangedId = null;
            }

            if (this._propertiesSubscriptionId) {
                try {
                    const connection = Gio.bus_get_sync(Gio.BusType.SESSION, null);
                    connection.signal_unsubscribe(this._propertiesSubscriptionId);
                } catch (e) { }
                this._propertiesSubscriptionId = null;
            }

            this._soupSession.abort();
            this._cancelArtSwap();
            St.TextureCache.get_default().disconnect(this._textureFileChangedId);

            this._dbusProxy = null;
            this._proxy = null;
            this._playerProxy = null;
            super.destroy();
        }
    });

export default class MusicLyricsExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._indicator = null;
        this._settings = null;
    }

    enable() {
        this._settings = this.getSettings();
        this._createIndicator();

        // Moving an indicator between panel boxes isn't supported by the panel API,
        // so rebuild it in the new position
        this._settingsSignalId = this._settings.connect('changed::position-in-panel', () => {
            this._destroyIndicator();
            this._createIndicator();
        });

        // Opens or closes the dropdown; the shell rebinds it when the setting changes
        Main.wm.addKeybinding('toggle-menu-shortcut', this._settings, Meta.KeyBindingFlags.NONE,
            // (POPUP so the same shortcut closes it again while it holds the keyboard)
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
            () => this._indicator?.menu.toggle());
    }

    disable() {
        Main.wm.removeKeybinding('toggle-menu-shortcut');

        if (this._settingsSignalId) {
            this._settings.disconnect(this._settingsSignalId);
            this._settingsSignalId = null;
        }

        this._destroyIndicator();
        this._settings = null;
    }

    _createIndicator() {
        this._indicator = new MusicLyricsIndicator(this._settings);

        const position = this._settings.get_string('position-in-panel');
        const box = position === 'left-half' ? 'left' : ['left', 'center'].includes(position) ? position : 'right';
        // Place after existing items on the left, before them elsewhere
        const index = box === 'left' ? Main.panel._leftBox.get_n_children() : 0;

        // addToStatusArea registers the menu with the panel's menu manager,
        // which is what gives the popup its input grab and keyboard focus
        Main.panel.addToStatusArea(this.uuid, this._indicator, index, box);

        if (position === 'left-half') {
            // Panel items can't stretch, so size the lyric to reach from where it starts
            // in the left box up to the clock in the center box. Resizing during the
            // allocation it reacts to would relayout mid-layout, so wait for it to finish.
            const container = this._indicator.container;
            const queueFill = () => {
                this._fillLaterId ??= global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
                    this._fillLaterId = null;
                    this._fillLeftOfClock();
                    return GLib.SOURCE_REMOVE;
                });
            };
            this._allocationId = container.connect('notify::allocation', queueFill);
            this._centerAllocationId = Main.panel._centerBox.connect('notify::allocation', queueFill);
            this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', queueFill);
        }
    }

    _fillLeftOfClock() {
        const indicator = this._indicator;
        if (!indicator) {
            return;
        }

        // From layout positions within the panel, as on-screen ones are thrown off
        // by transitions such as the startup zoom
        const container = indicator.container;
        const containerX = container.get_parent().allocation.x1 + container.allocation.x1;
        const centerX = Main.panel._centerBox.allocation.x1;
        // Whatever the panel button adds around the label, such as its padding
        const [, containerWidth] = container.get_preferred_width(-1);
        const overhead = containerWidth - indicator.labelWidth;
        indicator.setLabelWidth(Math.max(LABEL_MIN_FILL_WIDTH_PX, centerX - CLOCK_GAP_PX - containerX - overhead));
    }

    _destroyIndicator() {
        if (this._fillLaterId) {
            global.compositor.get_laters().remove(this._fillLaterId);
            this._fillLaterId = null;
        }
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = null;
        }
        if (this._centerAllocationId) {
            Main.panel._centerBox.disconnect(this._centerAllocationId);
            this._centerAllocationId = null;
        }
        if (this._allocationId) {
            this._indicator?.container.disconnect(this._allocationId);
            this._allocationId = null;
        }

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
