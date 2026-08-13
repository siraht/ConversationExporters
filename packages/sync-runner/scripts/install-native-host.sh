#!/bin/sh
set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
native_directory="$HOME/.mozilla/native-messaging-hosts"
escaped_host=$(printf '%s' "$script_directory/native-host.sh" | sed 's/[&|]/\\&/g')
mkdir -p "$native_directory"
sed "s|__HOST_PATH__|$escaped_host|" "$script_directory/../native-messaging/com.conversation_exporters.archive.json" > "$native_directory/com.conversation_exporters.archive.json"
chmod 0600 "$native_directory/com.conversation_exporters.archive.json"

chrome_id=${CONVERSATION_CHROME_EXTENSION_ID:-${CONVERSATION_EXPORTER_CHROME_ID:-}}
if [ -n "$chrome_id" ]; then
  case "$chrome_id" in *[!a-p]*) printf '%s\n' "Chrome's extension ID must use only a-p." >&2; exit 1;; esac
  if [ "${#chrome_id}" -ne 32 ]; then printf '%s\n' "Chrome's extension ID must contain 32 characters." >&2; exit 1; fi
  for chrome_directory in "$HOME/.config/google-chrome/NativeMessagingHosts" "$HOME/.config/chromium/NativeMessagingHosts" "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"; do
    mkdir -p "$chrome_directory"
    sed -e "s|__HOST_PATH__|$escaped_host|" -e "s|__CHROME_EXTENSION_ID__|$chrome_id|" "$script_directory/../native-messaging/com.conversation_exporters.archive.chrome.json" > "$chrome_directory/com.conversation_exporters.archive.json"
    chmod 0600 "$chrome_directory/com.conversation_exporters.archive.json"
  done
fi
printf '%s\n' "Installed the Conversation Archive native host."
