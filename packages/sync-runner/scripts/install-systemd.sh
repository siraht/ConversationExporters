#!/bin/sh
set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
unit_directory="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

mkdir -p "$unit_directory"
install -m 0644 "$script_directory/../systemd/conversation-sync.service" "$unit_directory/conversation-sync.service"
sh "$script_directory/install-native-host.sh"
systemctl --user daemon-reload
systemctl --user disable conversation-exporter-browser.service 2>/dev/null || true
systemctl --user enable conversation-sync.service

printf '%s\n' "Enabled the optional conversation sync service."
