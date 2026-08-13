#!/bin/sh
set -eu
script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec /usr/bin/node "$script_directory/../dist/native-host.js"
