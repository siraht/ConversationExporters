#!/bin/sh
set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
unit_directory="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

mkdir -p "$unit_directory"
install -m 0644 "$script_directory/../systemd/conversation-sync.service" "$unit_directory/conversation-sync.service"
install -m 0644 "$script_directory/../systemd/conversation-exporter-browser.service" "$unit_directory/conversation-exporter-browser.service"
systemctl --user daemon-reload
systemctl --user enable conversation-sync.service conversation-exporter-browser.service

printf '%s\n' "Installed and enabled conversation sync services."
