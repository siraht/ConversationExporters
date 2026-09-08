#!/usr/bin/env python3
"""Committed browser exports over ASM's verified batch protocol. No local index."""
from __future__ import annotations

import argparse
import copy
from contextlib import closing
from dataclasses import asdict, replace
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from datetime import datetime, timezone, timedelta

# Use an installed ASM source runtime, not a second vendored control plane.
runtime = os.environ.get("ASM_RUNTIME_SRC")
if runtime:
    sys.path.insert(0, runtime)
else:
    import shutil
    executable = shutil.which(os.environ.get("ASM_BINARY", "asm"))
    if executable:
        sys.path.insert(0, str(Path(executable).resolve().parent / "src"))
        for site in (Path(executable).resolve().parent.parent / "lib").glob("python*/site-packages"):
            if (site / "agent_session_archive").is_dir():
                sys.path.insert(0, str(site))

from agent_session_archive.config import ArchiveConfig, load_config, initialize_layout
from agent_session_archive.registry import Registry
from agent_session_archive.snapshot import create_snapshot
from agent_session_archive.transfer import prepare_transfer, _ssh, SSH_TRANSPORT
from agent_session_archive.ingest import ingest_ready
from agent_session_archive.blobs import BlobStore
from agent_session_archive.util import atomic_write, canonical_json_bytes, sha256_file
from agent_session_archive.refresh import refresh_portable
from agent_session_archive import web_ingest
from agent_session_archive.adapters.base import Adapter, Candidate, Detection, message_event, text_blocks, fidelity_event, asset_block
from agent_session_archive.adapters.claude_web import ClaudeAdapter
from agent_session_archive.adapters.gemini_web import GeminiAdapter
from agent_session_archive.adapters.google_ai_studio import GoogleAiStudioAdapter
from agent_session_archive.adapters.chatgpt_web import ChatGptAdapter
from agent_session_archive.adapters.grok_web import GrokAdapter
from agent_session_archive.asif import AsifDocument

SCHEMA = "conversation-export-generation/1"
PROVIDERS = {"chatgpt-web", "claude-web", "gemini-web", "grok-web", "google-ai-studio", "run-history"}

def now():
    return datetime.now(timezone.utc).isoformat()

def save(path, value):
    atomic_write(path, canonical_json_bytes(value), mode=0o600)

def read(path, default=None):
    return json.loads(path.read_text()) if path.exists() else default

def token(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", value):
        raise ValueError("Invalid archive identity")
    return value

def safe(root, relative):
    if not isinstance(relative, str) or "\\" in relative or "\x00" in relative:
        raise ValueError("Invalid archive path")
    path = Path(relative)
    if path.is_absolute() or any(p in {"", ".", ".."} for p in relative.split("/")):
        raise ValueError("Invalid archive path")
    target = root / path
    if not target.resolve().is_relative_to(root.resolve()):
        raise ValueError("Archive path escapes root")
    return target

def validate_generation(root):
    manifest = read(root / "_generation.json")
    if not isinstance(manifest, dict) or manifest.get("schema") != SCHEMA or manifest.get("namespace") not in PROVIDERS:
        raise ValueError("Unsupported generation manifest")
    token(manifest["id"]); token(manifest["account"])
    seen = set()
    for item in manifest["files"]:
        name = item["path"]
        if name in seen or name == "_generation.json":
            raise ValueError("Duplicate generation path")
        seen.add(name)
        path = safe(root, name)
        if path.is_symlink() or not path.is_file() or path.stat().st_size != item["size"] or sha256_file(path) != item["sha256"]:
            raise ValueError("Generation integrity check failed")
    actual = {p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file()}
    if actual != seen | {"_generation.json"}:
        raise ValueError("Generation contains unlisted or missing files")
    return manifest

def queue_snapshot(config, registry, host, snapshot_id):
    """Reuse ASM verification/commit commands, deliberately omit inline ingest-ready."""
    plan = prepare_transfer(config, registry, config.machine_name, host, snapshot_id=snapshot_id)
    response = _ssh(config, host, ["transfer", "receive", plan.source_machine_id, plan.batch_id])
    if response.get("status") != "ready":
        remote = f"{host}:{config.remote_root}/incoming/{plan.source_machine_id}/{plan.batch_id}.partial"
        common = ["rsync", "-e", " ".join(SSH_TRANSPORT), "--archive", "--protect-args", "--partial", "--partial-dir=.rsync-partial", "--chmod=F600,D700"]
        subprocess.run([*common, plan.manifest_path, f"{remote}/manifest.json"], check=True, timeout=300, stdout=subprocess.DEVNULL)
        _ssh(config, host, ["transfer", "seed", plan.source_machine_id, plan.batch_id, plan.manifest_hash])
        # Do not ignore an interrupted/corrupt destination file just because it exists.
        subprocess.run([*common, "--checksum", f"{plan.object_directory}/", f"{remote}/objects/"], check=True, timeout=2400, stdout=subprocess.DEVNULL)
        _ssh(config, host, ["transfer", "verify", plan.source_machine_id, plan.batch_id, plan.manifest_hash])
        _ssh(config, host, ["transfer", "commit", plan.source_machine_id, plan.batch_id, plan.manifest_hash, "--source-machine-name", plan.source_machine_name])
    return {"batchId": plan.batch_id, "snapshotId": plan.transfer_snapshot_id, "status": "received", "receivedAt": now(), "bytes": plan.bytes, "objects": plan.objects}

def deliver(args):
    root = args.data_root.resolve()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    host = token(args.destination)
    remote_root = args.remote_root
    if not re.fullmatch(r"/[A-Za-z0-9._/-]+", str(remote_root)) or ".." in remote_root.parts:
        raise ValueError("Remote root must be a safe absolute path")
    destination_id = hashlib.sha256(f"{host}:{remote_root}".encode()).hexdigest()[:20]
    spool = root / "asm-spool" / destination_id
    machine = token(args.machine)
    config = ArchiveConfig(root=spool, machine_name=machine, ssh_host=host, remote_root=remote_root)
    initialize_layout(spool, machine_name=machine)
    # This transport-only root must never capture native harnesses by default.
    text = f'[archive]\nroot = {json.dumps(str(spool))}\n[machine]\nname = {json.dumps(machine)}\n[sync]\nssh_host = {json.dumps(host)}\nremote_root = {json.dumps(str(remote_root))}\n'
    atomic_write(spool / "config.toml", text.encode(), mode=0o600)
    registry = Registry(config.registry_path)
    registry.migrate()
    state_path = root / f"delivery-state-{destination_id}.json"
    state = read(state_path, {"generations": {}})
    failures = []
    attempts = 0
    for generation in sorted((root / "outbox").glob("*"), key=lambda path: path.stat().st_mtime):
        if generation.is_symlink() or not generation.is_dir():
            continue
        entry = state["generations"].setdefault(generation.name, {})
        if not entry:
            local = read(generation / "receipt.json", {})
            entry.update({"status": "queued", "bytes": local.get("bytes", 0)})
        if entry.get("semantic") in {"complete", "not-required"} and entry.get("indexed"):
            continue
        if entry.get("nextAttemptAt") and datetime.fromisoformat(entry["nextAttemptAt"]) > datetime.now(timezone.utc):
            continue
        if attempts >= 8:
            continue
        attempts += 1
        try:
            if not entry.get("snapshotId"):
                manifest = validate_generation(generation / "files")
                capture_config = replace(config, provider_paths={"web-exports": (generation / "files",)})
                captured = create_snapshot(capture_config, registry, machine)
                entry.update({"snapshotId": captured.snapshot_id, "namespace": manifest["namespace"], "status": "queued", "bytes": sum(f["size"] for f in manifest["files"])})
                save(state_path, state)
            if not entry.get("batchId"):
                receipt = queue_snapshot(config, registry, host, entry["snapshotId"])
                entry.update({**receipt, "sourceSnapshotId": entry["snapshotId"]})
                save(state_path, state)
            # Receipt inspection is read-only; ingestion belongs to the VPS service.
            status = remote_receipt(args, entry["batchId"])
            entry.update(status)
            if not status.get("error"):
                entry.pop("error", None)
            entry.pop("nextAttemptAt", None); entry.pop("attempts", None)
        except Exception as exc:
            # Do not expose chat content or raw provider errors in operational logs.
            entry["error"] = f"{type(exc).__name__}: delivery or ingest pending; inspect the service journal"
            entry["attempts"] = entry.get("attempts", 0) + 1
            entry["nextAttemptAt"] = (datetime.now(timezone.utc) + timedelta(minutes=min(60, 5 * 2 ** min(entry["attempts"] - 1, 4)))).isoformat()
            failures.append(generation.name)
        save(state_path, state)
    entries = list(state["generations"].values())
    failures = [x for x in entries if x.get("error")]
    summary = {"schema": "conversation-delivery-status/1", "checkedAt": now(), "status": "attention" if failures else "idle", "destination": host,
               "queued": sum(not x.get("receivedAt") for x in entries), "queuedBytes": sum(x.get("bytes", 0) for x in entries if not x.get("receivedAt")),
               "received": sum(bool(x.get("receivedAt")) for x in entries), "imported": sum(x.get("imported") is True for x in entries),
               "indexed": sum(x.get("indexed") is True for x in entries), "semanticPending": sum(x.get("imported") is True and x.get("semantic") not in {"complete", "not-required"} for x in entries),
               "failed": len(failures), "generations": entries[-100:]}
    save(root / "delivery-status.json", summary)
    return summary

def remote_receipt(args, batch):
    import shlex
    command = ["python3", args.remote_helper, "status", "--root", str(args.remote_root), "--batch", token(batch)]
    process = subprocess.run([*SSH_TRANSPORT, token(args.destination), shlex.join(command)], check=True, text=True, capture_output=True, timeout=45)
    return json.loads(process.stdout)

class CurrentDirectoryAdapter(Adapter):
    """Current direct-provider layouts, preserving provider IDs and raw payloads."""
    version = "1.0.0"

    def __init__(self, provider):
        self.provider = provider

    def detect(self, source):
        marker = read(source / "_generation.json") if source.is_dir() else None
        return Detection(self.provider, "unified-extension-directory-v1", 1.0, source) if marker and marker.get("namespace") == self.provider else None

    def enumerate(self, source, detection):
        glob = "prompts/*/prompt.json" if self.provider == "google-ai-studio" else "conversations/*/conversation.json"
        for path in sorted(source.glob(glob)):
            payload = read(path)
            identity = payload.get("uuid") or payload.get("id")
            if not identity:
                raise ValueError("Conversation has no stable provider ID")
            yield Candidate(self.provider, detection.variant, str(identity), payload, path, source)

    def parse(self, candidate, account_id, raw_sha256):
        if self.provider == "claude-web":
            payload = copy.deepcopy(candidate.payload)
            # Provider sandbox paths are not paths on the archive host. The verified
            # exporter assets.json supplies local references; originals stay in raw.
            for message in payload.get("chat_messages") or payload.get("messages") or []:
                for field in ("attachments", "files"):
                    for attachment in message.get(field) or []:
                        if isinstance(attachment, dict):
                            attachment.pop("path", None)
            document = ClaudeAdapter().parse(replace(candidate, payload=payload), account_id, raw_sha256)
        elif self.provider == "gemini-web":
            document = GeminiAdapter().parse(candidate, account_id, raw_sha256)
        elif self.provider == "grok-web":
            document = GrokAdapter().parse(candidate, account_id, raw_sha256)
            parents = {m["id"]: m.get("parentId") for m in candidate.payload.get("messages", []) if isinstance(m, dict) and m.get("id")}
            for event in document.events:
                if event.get("type") == "message":
                    parent = parents.get(event["id"])
                    event["parent_id"] = parent if parent in parents else None
        else:
            detail = candidate.payload.get("detail")
            if isinstance(detail, dict) and isinstance(detail.get("chunkedPrompt"), dict):
                payload = {**detail, "_title": candidate.payload.get("title")}
                document = GoogleAiStudioAdapter().parse(replace(candidate, payload=payload), account_id, raw_sha256)
            else:
                # Opaque protobuf JSON remains searchable without inventing roles/branches.
                session = {"type": "session", "schema": "asif/1", "conversation_id": self.identity(candidate, account_id), "source": {"provider": self.provider, "account_id": account_id, "native_id": candidate.native_id, "variant": candidate.variant}, "title": candidate.payload.get("title"), "started_at": None, "ended_at": None, "raw_refs": [f"sha256:{raw_sha256}"]}
                events = [message_event("raw-prompt", None, "unknown", None, text_blocks(json.dumps(detail, ensure_ascii=False), self.provider), self.provider, {"representation": "opaque-provider-payload"}), fidelity_event(candidate.variant, ["opaque_prompt_payload"], ["provider_roles_and_branches_not_reconstructed"])]
                document = AsifDocument(session, tuple(events))
        events = list(document.events)
        assets = read(candidate.source.parent / "assets.json", [])
        if isinstance(assets, dict):
            assets = assets.get("records", [])
        blocks = []
        for asset in assets:
            path = asset.get("path") or asset.get("localPath")
            if path and not asset.get("error"):
                blocks.append(asset_block(candidate, path, "file", asset.get("name")))
        if blocks:
            # Export metadata, not a fabricated provider-authored chat turn.
            events.append(message_event("archive-attachments", None, "unknown", None, blocks, self.provider, {"representation": "archive-attachment-manifest"}))
        document.session.setdefault("extensions", {})["archive_capture"] = {
            "complete": (candidate.source.parent / "complete.json").exists(),
            "partial": (candidate.source.parent / "incomplete.json").exists(),
            "failed": (candidate.source.parent / "error.json").exists(),
        }
        return AsifDocument(document.session, tuple(events))

def import_directory(config, registry, source, manifest, machine_id):
    provider = manifest["namespace"]
    if provider == "run-history":
        return {"new_versions": 0, "candidates": 0, "metadataOnly": True}
    roots = sorted(p.parent for p in source.glob("*/archive.json")) if provider == "chatgpt-web" else [source]
    if not roots:
        raise ValueError("No recognized workspace archive in generation")
    added = candidates = 0
    for current in roots:
        result = web_ingest.ingest_web_export(config, registry, current, manifest["account"], provider, source_machine_id=machine_id)
        added += result.new_versions; candidates += result.candidates
    return {"new_versions": added, "candidates": candidates}

def process_generations(config, registry):
    from tempfile import TemporaryDirectory
    from agent_session_archive.views import replace_derived
    web_ingest.ADAPTERS = (PartialChatGptAdapter(),) + tuple(CurrentDirectoryAdapter(p) for p in ("claude-web", "gemini-web", "google-ai-studio", "grok-web")) + tuple(a for a in web_ingest.ADAPTERS if not isinstance(a, (CurrentDirectoryAdapter, PartialChatGptAdapter)))
    with closing(registry.connect(readonly=True)) as connection:
        rows = list(connection.execute("SELECT s.snapshot_id,s.machine_id,e.relative_path FROM snapshots s JOIN snapshot_entries e ON e.snapshot_id=s.snapshot_id WHERE e.provider='web-exports' AND e.excluded=0 AND e.relative_path LIKE '%/_generation.json' ORDER BY s.created_at,s.snapshot_id"))
    store = BlobStore(config.root / "blobs", config.storage)
    results = []
    for row in rows:
        snapshot = str(row["snapshot_id"])
        receipt_path = config.root / "run" / "web-delivery" / f"{token(snapshot)}.json"
        receipt = read(receipt_path, {"snapshotId": snapshot})
        if receipt.get("imported"):
            results.append(receipt); continue
        try:
            with closing(registry.connect(readonly=True)) as connection:
                entries = list(connection.execute("SELECT relative_path,sha256,size FROM snapshot_entries WHERE snapshot_id=? AND provider='web-exports' AND excluded=0", (snapshot,)))
            prefix = Path(row["relative_path"]).parent
            with TemporaryDirectory(prefix="web-generation-", dir=config.root / "staging") as temporary:
                root = Path(temporary)
                for entry in entries:
                    relative = Path(entry["relative_path"])
                    if not relative.is_relative_to(prefix):
                        raise ValueError("Unexpected source outside generation")
                    target = safe(root, relative.relative_to(prefix).as_posix())
                    blob = store.verify(str(entry["sha256"]), int(entry["size"]))
                    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    replace_derived(blob, target)
                manifest = validate_generation(root)
                result = import_directory(config, registry, root, manifest, str(row["machine_id"]))
                validation = read(root / "validation.json", {})
                receipt.update({"generationId": manifest["id"], "namespace": manifest["namespace"], "imported": True, "importedAt": now(), "coverageComplete": validation.get("valid") is True, **result})
                if result.get("metadataOnly"):
                    receipt.update({"indexed": True, "indexRequired": False, "semantic": "not-required"})
                receipt.pop("error", None)
        except Exception as exc:
            receipt.update({"imported": False, "error": f"{type(exc).__name__}: generation validation or adapter import failed"})
        save(receipt_path, receipt)
        results.append(receipt)
    return results

def process(args):
    for unit in args.pause_unit:
        if subprocess.run(["systemctl", "is-active", "--quiet", unit], check=False).returncode == 0:
            return {"status": "deferred", "reason": "Existing archive maintenance is active"}
    config = load_config(root=args.root)
    registry = Registry(config.registry_path)
    # The service takes the same flock as native refresh. Never index locally.
    destination = registry.ensure_machine(config.machine_name or "flywheel", config.machine_id)
    received = ingest_ready(config, registry, destination)
    results = process_generations(config, registry)
    if not any(r.get("imported") and not r.get("indexed") for r in results):
        return {"receivedBatches": len(received), "generations": results, "index": {"status": "unchanged"}}
    try:
        # Web imports add portable records only. Native capture has its own worker;
        # do not scan every native machine while draining this queue.
        lexical = refresh_portable(replace(config, index=replace(config.index, semantic_updates=False)), registry)
        for receipt in results:
            if receipt.get("imported") and not receipt.get("indexed"):
                receipt.update({"indexed": True, "indexedAt": now(), "semantic": "pending" if lexical.get("changed_paths", 0) else "not-required"})
                save(config.root / "run" / "web-delivery" / f"{receipt['snapshotId']}.json", receipt)
    except Exception as exc:
        lexical = {"error": type(exc).__name__}
    return {"receivedBatches": len(received), "generations": results, "index": lexical}

def semantic(args):
    for unit in args.pause_unit:
        if subprocess.run(["systemctl", "is-active", "--quiet", unit], check=False).returncode == 0:
            return {"status": "deferred", "reason": "Existing archive maintenance is active"}
    config = load_config(root=args.root)
    pending = [(path, read(path)) for path in (config.root / "run/web-delivery").glob("*.json")]
    pending = [(path, receipt) for path, receipt in pending if receipt.get("indexed") and receipt.get("semantic") not in {"complete", "not-required"}]
    if not pending:
        return {"status": "unchanged"}
    # This existing driver owns the refresh lock and durable model checkpoints.
    from agent_session_archive.refresh import backfill_quality
    result = backfill_quality(config)
    for path, receipt in pending:
        receipt.update({"semantic": "complete", "semanticAt": now()})
        save(path, receipt)
    return {"status": "complete", "generations": len(pending), "backfill": result}

class PartialChatGptAdapter(ChatGptAdapter):
    """Keep verified captured conversations searchable even in a partial export."""
    version = "1.1.1"

    def detect(self, source):
        if source.is_dir() and (source / "indexes/conversations.jsonl").is_file():
            manifest = read(source / "archive.json", {})
            if manifest.get("provider") == self.provider and manifest.get("schemaVersion") == 1:
                return Detection(self.provider, "chatgpt-exporter-directory-v1", 1.01, source / "indexes/conversations.jsonl")
        return super().detect(source)

def status(args):
    config = load_config(root=args.root)
    registry = Registry(config.registry_path)
    from agent_session_archive.transfer import transfer_status
    transfer = transfer_status(config, registry, token(args.batch))
    with closing(registry.connect(readonly=True)) as connection:
        row = connection.execute("SELECT snapshot_id FROM snapshots WHERE manifest_hash=?", (transfer.get("manifest_hash"),)).fetchone()
    snapshot = str(row[0]) if row else None
    result = read(config.root / "run" / "web-delivery" / f"{token(snapshot)}.json", {}) if snapshot else {}
    return {"batchId": args.batch, "rawStatus": transfer.get("status"), "imported": result.get("imported", False), "indexed": result.get("indexed", False), "semantic": result.get("semantic", "pending"), **result}

def main():
    os.umask(0o077)
    # Explicit CLI roots win over an interactive shell's unrelated ASM default.
    os.environ.pop("ASM_ARCHIVE_ROOT", None)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("deliver", "process", "status", "semantic"))
    parser.add_argument("--root", type=Path)
    parser.add_argument("--batch")
    parser.add_argument("--data-root", type=Path, default=Path.home() / "ConversationImports")
    parser.add_argument("--destination", default=os.environ.get("CONVERSATION_SYNC_DESTINATION"))
    parser.add_argument("--remote-root", type=Path, default=Path(os.environ.get("CONVERSATION_REMOTE_ARCHIVE_ROOT", "/data/agent-session-archive")))
    parser.add_argument("--remote-helper", default=os.environ.get("CONVERSATION_REMOTE_HELPER"))
    parser.add_argument("--machine", default=os.environ.get("CONVERSATION_WEB_MACHINE", "laptop-web"))
    parser.add_argument("--pause-unit", action="append", default=[], help="Defer processing while a maintenance service is active")
    args = parser.parse_args()
    if args.command == "deliver" and (not args.destination or not args.remote_helper):
        parser.error("deliver requires --destination and --remote-helper (or the corresponding environment variables)")
    if args.command != "deliver" and args.root is None:
        parser.error("--root is required for VPS operations")
    if args.command == "status" and not args.batch:
        parser.error("status requires --batch")
    lock_root = args.data_root if args.command == "deliver" else args.root / "run"
    lock_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if args.command == "status":
        print(json.dumps(status(args))); return
    if args.command == "semantic":
        print(json.dumps(semantic(args))); return
    with (lock_root / (".delivery.lock" if args.command == "deliver" else "refresh.lock")).open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(json.dumps({"status": "deferred", "reason": "Another archive worker owns the lock"})); return
        result = deliver(args) if args.command == "deliver" else process(args)
        print(json.dumps(result))

if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"ok": False, "error": type(error).__name__, "message": str(error)[:500]}), file=sys.stderr)
        sys.exit(1)
