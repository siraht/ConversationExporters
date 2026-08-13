#!/bin/sh
set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
package_directory=$(CDPATH= cd -- "$script_directory/.." && pwd)
config_directory="${XDG_CONFIG_HOME:-$HOME/.config}"
unit_directory="$config_directory/systemd/user"
environment_file="$config_directory/conversation-archive-receiver.env"
archive_root="${ARCHIVE_RECEIVER_ROOT:-$HOME/ConversationArchives}"

npm --prefix "$package_directory" run build
mkdir -p "$unit_directory" "$archive_root"
chmod 0700 "$archive_root"
if [ ! -f "$environment_file" ]; then
  generated_token=$(/usr/bin/node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')
  {
    printf '%s\n' "ARCHIVE_RECEIVER_ROOT=$archive_root"
    printf '%s\n' "ARCHIVE_RECEIVER_TOKEN=$generated_token"
    printf '%s\n' "ARCHIVE_RECEIVER_HOST=127.0.0.1"
    printf '%s\n' "ARCHIVE_RECEIVER_PORT=8787"
  } > "$environment_file"
  chmod 0600 "$environment_file"
fi
escaped_server=$(printf '%s' "$package_directory/dist/server.js" | sed 's/[&|]/\\&/g')
escaped_environment=$(printf '%s' "$environment_file" | sed 's/[&|]/\\&/g')
sed -e "s|__SERVER_PATH__|$escaped_server|" -e "s|__ENVIRONMENT_PATH__|$escaped_environment|" "$package_directory/systemd/conversation-archive-receiver.service" > "$unit_directory/conversation-archive-receiver.service"
systemctl --user daemon-reload
systemctl --user enable --now conversation-archive-receiver.service
printf '%s\n' "Receiver installed. Put an HTTPS reverse proxy in front of 127.0.0.1:8787."
printf '%s\n' "The private endpoint and token configuration is in $environment_file."
