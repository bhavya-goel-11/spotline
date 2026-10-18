import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const MPRIS_PLAYER_PATH = '/org/mpris/MediaPlayer2';
const MPRIS_PLAYER_INTERFACE = 'org.mpris.MediaPlayer2.Player';

// Lyrics API configuration
const LYRICS_API_URL = 'https://lrclib.net/api/get';
const LYRICS_SEARCH_URL = 'https://lrclib.net/api/search';
const LYRICS_DURATION_TOLERANCE_S = 5;
const LYRICS_CACHE_MAX_BYTES = 10 * 1024 * 1024;
const LYRICS_CACHE_PRUNE_INTERVAL_US = 10 * 60 * GLib.USEC_PER_SEC;

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

            // Create a box to hold label and info icon
            const box = new St.BoxLayout({
                style_class: 'panel-status-menu-box'
            });

            this._label = new St.Label({
                text: 'No music playing',
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'spotify-lyrics-label'
            });

            // Enable text clipping with ellipsis
            this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;

            // Info icon button
            this._infoIcon = new St.Icon({
                icon_name: 'dialog-information-symbolic',
                style_class: 'system-status-icon',
                icon_size: 16,
                y_align: Clutter.ActorAlign.CENTER,
                opacity: 0,
                reactive: true
            });

            box.add_child(this._label);
            box.add_child(this._infoIcon);
            this.add_child(box);

            // Show/hide info icon on hover
            this.connect('enter-event', () => {
                this._infoIcon.ease({
                    opacity: 255,
                    duration: 200,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD
                });
                // Update truncation on hover just in case
                this._updateLabelText();
            });

            this.connect('leave-event', () => {
                this._infoIcon.ease({
                    opacity: 0,
                    duration: 200,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD
                });
            });

            this._currentTrack = null;
            this._currentLyrics = null;
            this._currentLine = '';
            this._lyricsCache = new Map();
            this._lyricsCacheDir = GLib.build_filenamev([
                GLib.get_user_cache_dir(),
                'spotline',
                'lyrics-v1'
            ]);
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

            // Internal state for lyrics - using GSettings for preferences now
            this._showLyrics = true;
            this._isDestroyed = false;
            this._maxLength = this._settings.get_int('max-text-length');
            this._lyricsOffset = this._settings.get_int('lyrics-offset');

            // Connect setting signals
            this._settingsSignalId = this._settings.connect('changed::max-text-length', () => {
                this._maxLength = this._settings.get_int('max-text-length');
                this._updateLabelText();
            });

            this._offsetSignalId = this._settings.connect('changed::lyrics-offset', () => {
                this._lyricsOffset = this._settings.get_int('lyrics-offset');
            });

            this.menu.box.add_style_class_name('spotline-menu');
            this._buildMenu();
            this._initLyricsCacheDirectory();
            this._setupDBusMonitoring();
        }

        _buildMenu() {
            // Player info section
            this._playerInfoItem = new PopupMenu.PopupMenuItem('No player connected', {
                reactive: false
            });
            this._playerInfoItem.label.style = 'font-size: 0.85em; color: #888;';
            this.menu.addMenuItem(this._playerInfoItem);

            // Track info section
            this._trackInfoItem = new PopupMenu.PopupMenuItem('No track playing', {
                reactive: false
            });
            // Wrap long names inside the fixed-width menu instead of widening it
            this._trackInfoItem.label.x_expand = true;
            this._trackInfoItem.label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            this._trackInfoItem.label.clutter_text.line_wrap = true;
            this._trackInfoItem.label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            this.menu.addMenuItem(this._trackInfoItem);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // Playback controls
            const controlsBox = new St.BoxLayout({
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                style: 'spacing: 12px;'
            });

            const makeControlButton = (iconName, action) => {
                const button = new St.Button({
                    style_class: 'button',
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

            const controlsItem = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false
            });
            controlsItem.add_child(controlsBox);
            this.menu.addMenuItem(controlsItem);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // Toggle lyrics display
            this._lyricsToggle = new PopupMenu.PopupSwitchMenuItem(
                'Show Lyrics',
                this._showLyrics
            );
            this._lyricsToggle.connect('toggled', (item) => {
                this._showLyrics = item.state;
                if (!item.state) {
                    if (this._lyricsTimeoutId) {
                        GLib.source_remove(this._lyricsTimeoutId);
                        this._lyricsTimeoutId = null;
                    }
                    this._updateTrackInfo(true);
                } else {
                    this._updateTrackInfo(true);
                }
            });
            this.menu.addMenuItem(this._lyricsToggle);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // Refresh button
            const refreshItem = new PopupMenu.PopupMenuItem('Refresh Player');
            refreshItem.connect('activate', () => {
                this._findActivePlayer();
            });
            this.menu.addMenuItem(refreshItem);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // Info submenu
            this._infoSubmenu = new PopupMenu.PopupSubMenuMenuItem('About');

            // GitHub link
            const githubItem = new PopupMenu.PopupMenuItem('View on GitHub');
            githubItem.connect('activate', () => {
                Gio.AppInfo.launch_default_for_uri(
                    'https://github.com/d3osaju/Spotline',
                    null
                );
            });
            this._infoSubmenu.menu.addMenuItem(githubItem);

            // Credits
            const creditsItem = new PopupMenu.PopupMenuItem('Created by deosaju', {
                reactive: false
            });
            creditsItem.label.style = 'font-size: 0.9em; color: #888;';
            this._infoSubmenu.menu.addMenuItem(creditsItem);

            this.menu.addMenuItem(this._infoSubmenu);
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

            this._updatePlayerInfo();
            this._trackInfoItem.label.text = 'No track playing';
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

                this._updatePlayerInfo();
                this._updatePlayPauseButton();
                this._updateTrackInfo();
                return true;
            } catch (e) {
                logError(e, `Failed to connect to ${busName}`);
                return false;
            }
        }

        _updatePlayerInfo() {
            if (!this._currentBusName) {
                this._playerInfoItem.label.text = 'No player connected';
                return;
            }

            let playerName = 'Unknown Player';
            let playerIcon = '♪';

            if (this._currentBusName.includes('spotify')) {
                playerName = 'Spotify';
                playerIcon = '🎵';
            } else if (this._currentBusName.includes('youtube-music')) {
                playerName = 'YouTube Music';
                playerIcon = '🎵';
            } else if (this._currentBusName.includes('chromium')) {
                playerName = 'Chromium';
                playerIcon = '🌐';
            } else if (this._currentBusName.includes('chrome')) {
                playerName = 'Chrome';
                playerIcon = '🌐';
            } else if (this._currentBusName.includes('firefox')) {
                playerName = 'Firefox';
                playerIcon = '🌐';
            } else if (this._currentBusName.includes('brave')) {
                playerName = 'Brave';
                playerIcon = '🌐';
            } else if (this._currentBusName.includes('edge')) {
                playerName = 'Edge';
                playerIcon = '🌐';
            }

            this._playerInfoItem.label.text = `${playerIcon} Playing from ${playerName}`;
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
                    this._trackInfoItem.label.text = 'No track playing';
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
                const durationVariant = metadataDict['mpris:length'];
                if (durationVariant) {
                    const unpackedDuration = durationVariant.deep_unpack();
                    duration = Math.round(unpackedDuration / 1000000); // Convert microseconds to seconds
                }

                // If both title and artist are missing, show icon or nothing
                if (title === 'Unknown Track' && artist === 'Unknown Artist') {
                    this._updateLabelText('♪');
                    this._trackInfoItem.label.text = 'Unknown track';
                    return;
                }

                // Check if lyrics query inputs changed to avoid redundant API calls
                const lyricsQueryChanged = forceFetch ||
                                           !this._currentTrack ||
                                           this._currentTrack.title !== title ||
                                           this._currentTrack.artist !== artist;

                this._currentTrack = {
                    title: title,
                    artist: artist,
                    album: album,
                    duration: duration
                };

                // Update menu with track info
                this._trackInfoItem.label.text = `${this._currentTrack.artist} - ${this._currentTrack.title}`;

                // Only fetch lyrics if the query inputs changed or it's forced
                if (lyricsQueryChanged) {
                    // Update label immediately with song info
                    this._updateLabelText(`${this._currentTrack.artist} - ${this._currentTrack.title}`);

                    // Try to fetch lyrics if enabled
                    if (this._showLyrics) {
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

        _fetchLyrics(title, artist, album, duration) {
            // Clear any existing lyrics timeout
            if (this._lyricsTimeoutId) {
                GLib.source_remove(this._lyricsTimeoutId);
                this._lyricsTimeoutId = null;
            }

            // Clear previous lyrics state
            this._currentLyrics = null;
            this._currentLine = '';

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

                    if (text) {
                        lines.push({ time: timeMs, text: text });
                    }
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

                            // Find the current lyric line
                            let currentLine = this._currentLyrics[0].text;

                            for (let i = this._currentLyrics.length - 1; i >= 0; i--) {
                                if (this._currentLyrics[i].time <= positionMs) {
                                    currentLine = this._currentLyrics[i].text;
                                    break;
                                }
                            }

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

        _updateLabelText(text = null) {
            if (text !== null) {
                this._currentText = text;
            }

            const display = this._currentText || 'No music playing';
            this._label.set_text(this._truncateText(display, this._maxLength));
        }

        _truncateText(text, maxLength) {
            if (text.length <= maxLength) {
                return text;
            }
            return text.substring(0, maxLength - 3) + '...';
        }

        destroy() {
            this._isDestroyed = true;

            if (this._settingsSignalId) {
                this._settings.disconnect(this._settingsSignalId);
                this._settingsSignalId = null;
            }

            if (this._offsetSignalId) {
                this._settings.disconnect(this._offsetSignalId);
                this._offsetSignalId = null;
            }

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
    }

    disable() {
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
            // The panel boxes can't place an item at an arbitrary point, so keep it in the
            // left box and slide it over visually. Translation doesn't affect layout, and
            // both input picking and the menu's anchor follow the transformed position.
            const container = this._indicator.container;
            this._allocationId = container.connect('notify::allocation', () => this._centerInLeftHalf());
            this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => this._centerInLeftHalf());
        }
    }

    _centerInLeftHalf() {
        const container = this._indicator?.container;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!container || !monitor) {
            return;
        }

        const [stageX] = container.get_transformed_position();
        const naturalX = stageX - container.translation_x;
        const targetX = monitor.x + monitor.width * 0.25 - container.width / 2;
        // Only ever move right, so it can't slide over the Activities button
        container.translation_x = Math.round(Math.max(0, targetX - naturalX));
    }

    _destroyIndicator() {
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = null;
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
