#!/bin/sh
set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
unit_directory="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
native_directory="$HOME/.mozilla/native-messaging-hosts"

mkdir -p "$unit_directory"
mkdir -p "$native_directory"
install -m 0644 "$script_directory/../systemd/conversation-sync.service" "$unit_directory/conversation-sync.service"
escaped_host=$(printf '%s' "$script_directory/native-host.sh" | sed 's/[&|]/\\&/g')
sed "s|__HOST_PATH__|$escaped_host|" "$script_directory/../native-messaging/com.conversation_exporters.archive.json" > "$native_directory/com.conversation_exporters.archive.json"
chmod 0600 "$native_directory/com.conversation_exporters.archive.json"
systemctl --user daemon-reload
systemctl --user disable conversation-exporter-browser.service 2>/dev/null || true
systemctl --user enable conversation-sync.service

printf '%s\n' "Installed the native host and enabled the conversation sync service."
