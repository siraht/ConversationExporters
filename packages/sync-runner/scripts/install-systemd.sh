#!/bin/sh
set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec python3 "$script_directory/install-delivery.py" laptop "$@"
