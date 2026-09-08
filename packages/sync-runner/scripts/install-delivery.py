#!/usr/bin/env python3
"""Install configurable user-level SSH delivery or VPS ingestion timers."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess

def quoted(value):
    value = str(value)
    if any(c in value for c in "\n\r\x00"):
        raise ValueError("Invalid service argument")
    # systemd expands percent specifiers even in quoted arguments.
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"'

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("laptop", "vps"))
    parser.add_argument("--data-root", type=Path, default=Path.home() / "ConversationImports")
    parser.add_argument("--archive-root", type=Path, default=Path("/data/agent-session-archive"))
    parser.add_argument("--destination")
    parser.add_argument("--remote-helper")
    parser.add_argument("--runtime-src", type=Path, required=True)
    parser.add_argument("--pause-unit", action="append", default=[])
    parser.add_argument("--enable", action="store_true", help="Start the timer after installing")
    args = parser.parse_args()
    if args.mode == "laptop" and (not args.destination or not args.remote_helper):
        parser.error("Laptop installation requires --destination and --remote-helper")
    runtime = args.runtime_src.resolve()
    if not (runtime / "agent_session_archive/transfer.py").is_file():
        parser.error("--runtime-src must contain the ASM Python package")
    os.umask(0o077)
    install = Path.home() / ".local/lib/conversation-exporters"
    install.mkdir(parents=True, exist_ok=True)
    helper = install / "archive-delivery.py"
    source_helper = Path(__file__).with_name("archive-delivery.py")
    if source_helper.resolve() != helper.resolve():
        shutil.copy2(source_helper, helper)
    units = Path.home() / ".config/systemd/user"
    units.mkdir(parents=True, exist_ok=True)
    name = "conversation-delivery" if args.mode == "laptop" else "conversation-web-ingest"
    arguments = ["/usr/bin/python3", helper, "deliver" if args.mode == "laptop" else "process"]
    if args.mode == "laptop":
        arguments += ["--data-root", args.data_root.resolve(), "--destination", args.destination, "--remote-root", args.archive_root, "--remote-helper", args.remote_helper]
    else:
        arguments += ["--root", args.archive_root]
        for unit in args.pause_unit:
            arguments += ["--pause-unit", unit]
    memory = "2G" if args.mode == "laptop" else "16G"
    cpu = "100%" if args.mode == "laptop" else "200%"
    # User units allow installations on a generic VPS without root-only layouts.
    service = f'''[Unit]
Description=Conversation archive {'SSH delivery' if args.mode == 'laptop' else 'verified ingestion'}
After=network-online.target

[Service]
Type=oneshot
ExecStart={' '.join(quoted(a) for a in arguments)}
Environment={quoted('ASM_RUNTIME_SRC=' + str(runtime))}
Environment=RAYON_NUM_THREADS=2 OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=2
UMask=0077
Nice=15
IOSchedulingClass=idle
MemoryMax={memory}
CPUQuota={cpu}
TimeoutStartSec=45min
KillMode=control-group
NoNewPrivileges=true
'''
    timer = f'''[Unit]
Description=Check for {'queued exports' if args.mode == 'laptop' else 'received web archives'}

[Timer]
OnStartupSec=2min
OnUnitActiveSec={'5min' if args.mode == 'laptop' else '2min'}
AccuracySec=15s
Unit={name}.service

[Install]
WantedBy=timers.target
'''
    (units / f"{name}.service").write_text(service)
    (units / f"{name}.timer").write_text(timer)
    if args.mode == "vps":
        semantic_arguments = ["semantic" if str(a) == "process" else a for a in arguments]
        semantic_service = service.replace('ExecStart=' + ' '.join(quoted(a) for a in arguments), 'ExecStart=' + ' '.join(quoted(a) for a in semantic_arguments)).replace("verified ingestion", "incremental semantic catch-up")
        (units / "conversation-web-semantic.service").write_text(semantic_service)
        (units / "conversation-web-semantic.timer").write_text(timer.replace(name, "conversation-web-semantic").replace("OnStartupSec=2min", "OnStartupSec=10min").replace("OnUnitActiveSec=2min", "OnUnitActiveSec=30min"))
    subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
    if args.enable:
        subprocess.run(["systemctl", "--user", "enable", "--now", f"{name}.timer"], check=True)
        if args.mode == "vps":
            subprocess.run(["systemctl", "--user", "enable", "--now", "conversation-web-semantic.timer"], check=True)
    print(f"Installed {name}.timer{' and enabled it' if args.enable else ' (not enabled)'}. Helper: {helper}")
    if args.mode == "vps":
        print("For operation after logout, enable user lingering with loginctl enable-linger USER. Verify memory and CPU limits are supported by your host's user cgroup.")

if __name__ == "__main__": main()
