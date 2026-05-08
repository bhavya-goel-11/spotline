import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const MPRIS_PLAYER_PATH = '/org/mpris/MediaPlayer2';
const MPRIS_PLAYER_INTERFACE = 'org.mpris.MediaPlayer2.Player';

// Lyrics API configuration
const LYRICS_API_URL = 'https://lrclib.net/api/get';
const LYRICS_CACHE_MAX_BYTES = 10 * 1024 * 1024;

// Helper function to check if a bus name is a supported music player
function isSupportedPlayer(busName) {
    // Desktop apps
    if (busName === 'org.mpris.MediaPlayer2.spotify' ||
        busName === 'org.mpris.MediaPlayer2.youtube-music') {
        return true;
    }

    // Browser-based players (chromium, chrome, firefox, etc.)
    // These have instance IDs like: org.mpris.MediaPlayer2.chromium.instance12345
    const browserPatterns = [
        /^org\.mpris\.MediaPlayer2\.chromium\.instance\d+$/,
        /^org\.mpris\.MediaPlayer2\.chrome\.instance\d+$/,
        /^org\.mpris\.MediaPlayer2\.firefox\.instance\d+$/,
        /^org\.mpris\.MediaPlayer2\.brave\.instance\d+$/,
        /^org\.mpris\.MediaPlayer2\.edge\.instance\d+$/
    ];

    return browserPatterns.some(pattern => pattern.test(busName));
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
            this._label.clutter_text.ellipsize = 3; // PANGO_ELLIPSIZE_END

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
            this._currentBusName = null;
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
            this.menu.addMenuItem(this._trackInfoItem);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // Playback controls
            const controlsBox = new St.BoxLayout({
                style_class: 'popup-menu-item',
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                style: 'spacing: 12px;'
            });

            const prevButton = new St.Button({
                style_class: 'button',
                child: new St.Icon({
                    icon_name: 'media-skip-backward-symbolic',
                    icon_size: 20
                })
            });
            prevButton.connect('clicked', () => this._controlPlayback('Previous'));

            const playPauseButton = new St.Button({
                style_class: 'button',
                child: new St.Icon({
                    icon_name: 'media-playback-start-symbolic',
                    icon_size: 20
                })
            });
            this._playPauseButton = playPauseButton;
            playPauseButton.connect('clicked', () => this._controlPlayback('PlayPause'));

            const nextButton = new St.Button({
                style_class: 'button',
                child: new St.Icon({
                    icon_name: 'media-skip-forward-symbolic',
                    icon_size: 20
                })
            });
            nextButton.connect('clicked', () => this._controlPlayback('Next'));

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
                return;
            }

            try {
                this._playerProxy.call(
                    action,
                    null,
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null,
                    (proxy, result) => {
                        try {
                            proxy.call_finish(result);
                        } catch (e) {
                            logError(e, `Failed to execute ${action}`);
                        }
                    }
                );
            } catch (e) {
                logError(e, `Failed to call ${action}`);
            }
        }

        _updatePlayPauseButton() {
            if (!this._playerProxy || !this._playPauseButton) {
                return;
            }

            try {
                const playbackStatus = this._playerProxy.get_cached_property('PlaybackStatus');
                if (playbackStatus) {
                    const status = playbackStatus.unpack();
                    const icon = status === 'Playing' ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
                    this._playPauseButton.child.icon_name = icon;
                }
            } catch (e) {
                logError(e, 'Failed to update play/pause button');
            }
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
                                    if (status === 'Playing') {
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

        _findActivePlayer() {
            try {
                const dbusProxy = Gio.DBusProxy.new_for_bus_sync(
                    Gio.BusType.SESSION,
                    Gio.DBusProxyFlags.NONE,
                    null,
                    'org.freedesktop.DBus',
                    '/org/freedesktop/DBus',
                    'org.freedesktop.DBus',
                    null
                );

                dbusProxy.call(
                    'ListNames',
                    null,
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null,
                    (proxy, result) => {
                        if (this._isDestroyed) return;
                        try {
                            const reply = proxy.call_finish(result);
                            const names = reply.get_child_value(0).deep_unpack();

                            // First try to find a playing supported player
                            let foundPlayer = null;

                            for (const name of names) {
                                if (isSupportedPlayer(name)) {
                                    if (this._isPlayerPlaying(name)) {
                                        foundPlayer = name;
                                        break;
                                    }
                                }
                            }

                            // If no playing player, connect to any supported player
                            if (!foundPlayer) {
                                for (const name of names) {
                                    if (isSupportedPlayer(name)) {
                                        foundPlayer = name;
                                        break;
                                    }
                                }
                            }

                            if (foundPlayer) {
                                this._tryConnectToPlayer(foundPlayer);
                            } else {
                                this._updateLabelText('No music playing');
                            }
                        } catch (e) {
                            logError(e, 'Failed to list DBus names');
                            this._updateLabelText('No music playing');
                        }
                    }
                );
            } catch (e) {
                logError(e, 'Failed to query DBus');
                this._updateLabelText('No music playing');
            }
        }

        _isPlayerPlaying(busName) {
            try {
                const playerProxy = Gio.DBusProxy.new_for_bus_sync(
                    Gio.BusType.SESSION,
                    Gio.DBusProxyFlags.NONE,
                    null,
                    busName,
                    MPRIS_PLAYER_PATH,
                    MPRIS_PLAYER_INTERFACE,
                    null
                );

                const playbackStatus = playerProxy.get_cached_property('PlaybackStatus');
                if (playbackStatus) {
                    const status = playbackStatus.unpack();
                    return status === 'Playing';
                }
            } catch (e) {
                // Ignore errors, player might not be available
            }
            return false;
        }

        _tryConnectToPlayer(busName) {
            if (this._currentBusName === busName) {
                return true;
            }

            try {
                // Create proxy for properties interface
                const proxy = Gio.DBusProxy.new_for_bus_sync(
                    Gio.BusType.SESSION,
                    Gio.DBusProxyFlags.NONE,
                    null,
                    busName,
                    MPRIS_PLAYER_PATH,
                    'org.freedesktop.DBus.Properties',
                    null
                );

                // Create proxy for player interface to monitor changes
                const playerProxy = Gio.DBusProxy.new_for_bus_sync(
                    Gio.BusType.SESSION,
                    Gio.DBusProxyFlags.NONE,
                    null,
                    busName,
                    MPRIS_PLAYER_PATH,
                    MPRIS_PLAYER_INTERFACE,
                    null
                );

                // Disconnect previous player if any
                if (this._propertiesChangedId && this._playerProxy) {
                    this._playerProxy.disconnect(this._propertiesChangedId);
                }

                this._proxy = proxy;
                this._playerProxy = playerProxy;
                this._currentBusName = busName;
                this._currentTrack = null;

                this._propertiesChangedId = this._playerProxy.connect(
                    'g-properties-changed',
                    this._onPropertiesChanged.bind(this)
                );

                this._updatePlayerInfo();
                this._updateTrackInfo();
                return true;
            } catch (e) {
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

        _onPropertiesChanged() {
            this._updateTrackInfo();
            this._updatePlayPauseButton();
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

            // Build API URL
            let url = `${LYRICS_API_URL}?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`;
            if (album && album !== 'Unknown Album') {
                url += `&album_name=${encodeURIComponent(album)}`;
            }
            if (duration && duration > 0) {
                url += `&duration=${duration}`;
            }

            const msg = Soup.Message.new('GET', url);

            this._soupSession.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, result) => {
                if (this._isDestroyed) return;
                try {
                    const bytes = session.send_and_read_finish(result);

                    // Check if the track has changed while we were fetching
                    if (!this._currentTrack || this._currentTrack.title !== title || this._currentTrack.artist !== artist) {
                        return;
                    }

                    if (msg.get_status() !== Soup.Status.OK) {
                        this._updateLabelText(`${artist} - ${title}`);
                        return;
                    }

                    const decoder = new TextDecoder('utf-8');
                    const response = decoder.decode(bytes.get_data());
                    const data = JSON.parse(response);

                    const lyricsResult = {
                        syncedLines: data.syncedLyrics ? this._parseLRC(data.syncedLyrics) : null,
                        plainFirstLine: data.plainLyrics ? data.plainLyrics.split('\n')[0] : null,
                        frequency: 1
                    };

                    this._lyricsCache.set(cacheKey, lyricsResult);
                    this._writeLyricsToDiskCache(cacheKey, lyricsResult);
                    this._displayLyricsResult(lyricsResult, title, artist);
                } catch (e) {
                    // Check if track has changed
                    if (!this._currentTrack || this._currentTrack.title !== title || this._currentTrack.artist !== artist) {
                        return;
                    }
                    logError(e, 'Failed to fetch lyrics');
                    this._updateLabelText(`${artist} - ${title}`);
                }
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
            this._writeLyricsToDiskCache(cacheKey, lyricsResult);
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
                        frequency: this._readLyricsCacheFrequency(path),
                        modified: info.get_attribute_uint64('time::modified')
                    });
                }

                enumerator.close(null);

                if (totalBytes <= LYRICS_CACHE_MAX_BYTES) {
                    return;
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
                this._updateCurrentLyricLine();
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
                        if (this._isDestroyed) return;
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
        this._indicator = new MusicLyricsIndicator(this._settings);

        this._updatePosition();

        this._settingsSignalId = this._settings.connect('changed::position-in-panel', () => {
            this._updatePosition();
        });
    }

    disable() {
        if (this._settingsSignalId) {
            this._settings.disconnect(this._settingsSignalId);
            this._settingsSignalId = null;
        }

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        this._settings = null;
    }

    _updatePosition() {
        if (!this._indicator) return;

        // Remove from current parent if applied
        if (this._indicator.get_parent()) {
            this._indicator.get_parent().remove_child(this._indicator);
        }

        const position = this._settings.get_string('position-in-panel');

        if (position === 'left') {
            Main.panel._leftBox.add_child(this._indicator);
        } else if (position === 'center') {
            Main.panel._centerBox.add_child(this._indicator);
        } else {
            // Default to right (status area)
            // We use addToStatusArea but need to handle re-adding carefully
            // addToStatusArea destroys existing indicator with same role, but we handle that

            // Since we manually removed it, we can just add it back using the panel method
            // or just use addToStatusArea again (which is safer for right side)
            Main.panel.addToStatusArea('music-lyrics-indicator', this._indicator);
        }
    }
}
