"""Integration tests against the installed ASM runtime, with synthetic exports only."""
import importlib.util
import json
import hashlib
from pathlib import Path
import tempfile
import unittest
from dataclasses import replace
from unittest.mock import patch

script = Path(__file__).parents[1] / "scripts" / "archive-delivery.py"
spec = importlib.util.spec_from_file_location("archive_delivery", script)
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)
from agent_session_archive.transfer import local_push_for_verification

class DeliveryTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="delivery-integration-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.config("source", "test-laptop-web")
        self.target = self.config("target", "test-vps")

    def config(self, name, machine):
        root = self.root / name
        d.initialize_layout(root, machine_name=machine)
        registry = d.Registry(root / "registry.sqlite3"); registry.migrate()
        return d.ArchiveConfig(root=root, machine_name=machine), registry

    def generation(self, provider, files, suffix="one"):
        root = self.root / f"export-{provider}-{suffix}"; root.mkdir()
        files = {**files, "validation.json": {"valid": True}}
        members = []
        for name, value in files.items():
            path = root / name; path.parent.mkdir(parents=True, exist_ok=True)
            data = value.encode() if isinstance(value, str) else json.dumps(value).encode()
            path.write_bytes(data)
            members.append({"path": name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()})
        (root / "_generation.json").write_text(json.dumps({"schema": d.SCHEMA, "id": f"test-{provider}-{suffix}", "namespace": provider, "account": "personal", "files": members}))
        return root

    def transfer(self, root):
        config, registry = self.source
        captured = d.create_snapshot(replace(config, provider_paths={"web-exports": (root,)}), registry, config.machine_name)
        plan = d.prepare_transfer(config, registry, config.machine_name, "test-vps", snapshot_id=captured.snapshot_id)
        local_push_for_verification(config, self.target[0], self.target[1], plan)
        return plan

    def test_all_provider_imports_and_unchanged_retry(self):
        samples = {
            "claude-web": {"conversations/a/conversation.json": {"uuid": "claude-a", "name": "Synthetic", "chat_messages": [{"uuid": "m", "sender": "human", "text": "Claude synthetic search evidence"}]}, "conversations/a/complete.json": {}},
            "gemini-web": {"conversations/a/conversation.json": {"id": "gemini-a", "messages": [{"id": "m", "role": "user", "content": "Gemini synthetic search evidence"}]}, "conversations/a/complete.json": {}},
            "google-ai-studio": {"prompts/a/prompt.json": {"id": "studio-a", "title": "Synthetic", "detail": ["Studio synthetic opaque evidence"]}, "prompts/a/complete.json": {}},
            "grok-web": {"inventory.json": {"provider": "grok"}, "conversations/a/conversation.json": {"provider": "grok", "id": "grok-a", "messages": [{"id": "m", "role": "user", "content": "Grok synthetic evidence"}]}},
        }
        normalized = {"conversationId": "chatgpt-a", "title": "Synthetic", "nodes": [{"id": "node", "messageId": "m"}], "messages": [{"id": "m", "role": "user", "parts": [{"kind": "text", "text": "ChatGPT synthetic evidence"}]}]}
        normalized_json = json.dumps(normalized)
        samples["chatgpt-web"] = {
            "ChatGPTExport-test/archive.json": {"provider": "chatgpt-web", "schemaVersion": 1},
            "ChatGPTExport-test/reports/validation.json": {"terminalState": "complete"},
            "ChatGPTExport-test/conversations/a/normalized.json": normalized_json,
            "ChatGPTExport-test/conversations/a/raw.json": {"id": "chatgpt-a"},
            "ChatGPTExport-test/indexes/conversations.jsonl": json.dumps({"conversationId": "chatgpt-a", "normalizedPath": "conversations/a/normalized.json", "rawPath": "conversations/a/raw.json", "normalizedHash": hashlib.sha256(normalized_json.encode()).hexdigest()}) + "\n",
        }
        for provider, files in samples.items():
            self.transfer(self.generation(provider, files))
        results = d.process_generations(*self.target)
        self.assertEqual(len(results), 5)
        self.assertTrue(all(r.get("imported") for r in results), results)
        self.assertEqual(sum(r["candidates"] for r in results), 5)
        self.assertEqual(sum(r["new_versions"] for r in results), 5)
        self.assertEqual(results, d.process_generations(*self.target))
        portable = list((self.target[0].root / "portable").glob("*/*.asif.jsonl"))
        self.assertEqual(len(portable), 5)

    def test_corruption_and_missing_files_never_publish(self):
        root = self.generation("run-history", {"run.json": {"status": "complete"}})
        (root / "run.json").write_text("corrupt")
        with self.assertRaises(ValueError): d.validate_generation(root)

    def test_failed_import_retries_without_new_upload(self):
        root = self.generation("claude-web", {"conversations/a/conversation.json": {"uuid": "a", "chat_messages": [{"sender": "human", "text": "test"}]}})
        self.transfer(root)
        with patch.object(d, "import_directory", side_effect=RuntimeError("injected")):
            self.assertFalse(d.process_generations(*self.target)[0]["imported"])
        self.assertTrue(d.process_generations(*self.target)[0]["imported"])

if __name__ == "__main__": unittest.main()
