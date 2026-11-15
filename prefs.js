import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class SpotLinePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup();

        // Position setting
        const positionRow = new Adw.ComboRow({
            title: 'Panel Position',
            model: new Gtk.StringList({
                strings: ['Left', 'Center', 'Right', 'Left Half, up to the Clock']
            })
        });

        // Map config values to combo index
        const positions = ['left', 'center', 'right', 'left-half'];
        positionRow.selected = positions.indexOf(settings.get_string('position-in-panel'));

        positionRow.connect('notify::selected', () => {
            settings.set_string('position-in-panel', positions[positionRow.selected]);
        });

        group.add(positionRow);

        // Lyrics Offset setting
        const offsetRow = new Adw.SpinRow({
            title: 'Lyrics Lookahead (ms)',
            subtitle: 'Time to show lyrics before they are sung (helps you sing along)',
            adjustment: new Gtk.Adjustment({
                lower: -2000,
                upper: 2000,
                step_increment: 100,
                value: settings.get_int('lyrics-offset')
            })
        });

        offsetRow.connect('notify::value', () => {
            settings.set_int('lyrics-offset', offsetRow.get_value());
        });

        group.add(offsetRow);

        page.add(group);

        // Display toggles, kept out of the dropdown so it stays uncluttered
        const displayGroup = new Adw.PreferencesGroup({title: 'Display'});

        const lyricsRow = new Adw.SwitchRow({
            title: 'Show Lyrics',
            subtitle: 'Synced lyrics in the top bar and over the album art'
        });
        settings.bind('show-lyrics', lyricsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        displayGroup.add(lyricsRow);

        const albumArtRow = new Adw.SwitchRow({
            title: 'Show Album Art',
            subtitle: 'Cover art in the dropdown, for Spotify'
        });
        settings.bind('show-album-art', albumArtRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        displayGroup.add(albumArtRow);

        page.add(displayGroup);

        const playerGroup = new Adw.PreferencesGroup({title: 'Player'});
        const refreshRow = new Adw.ActionRow({
            title: 'Refresh Player',
            subtitle: 'Look for the active music player again'
        });
        const refreshButton = new Gtk.Button({
            label: 'Refresh',
            valign: Gtk.Align.CENTER
        });
        // The extension runs in the shell process, so signal it through a setting
        refreshButton.connect('clicked', () => {
            settings.set_int('refresh-player-request',
                (settings.get_int('refresh-player-request') + 1) % 1000000);
        });
        refreshRow.add_suffix(refreshButton);
        playerGroup.add(refreshRow);
        page.add(playerGroup);

        const aboutGroup = new Adw.PreferencesGroup({title: 'About'});
        const githubRow = new Adw.ActionRow({
            title: 'View on GitHub',
            subtitle: 'Created by deosaju',
            activatable: true
        });
        githubRow.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
        githubRow.connect('activated', () => {
            new Gtk.UriLauncher({uri: 'https://github.com/d3osaju/Spotline'}).launch(window, null, null);
        });
        aboutGroup.add(githubRow);
        page.add(aboutGroup);

        window.add(page);
    }
}
