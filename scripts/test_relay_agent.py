import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from relay_agent import AgentConfig, RelayAgent, RelayError, execute_codex, resolve_working_directory


class FakeClient:
    def __init__(self, task):
        self.task = task
        self.calls = []

    def heartbeat(self, status, current_task_id=None):
        self.calls.append(("heartbeat", status, current_task_id))
        return {"ok": True}

    def claim(self):
        self.calls.append(("claim",))
        task = self.task
        self.task = None
        return {"ok": True, "task": task}

    def ack(self, task):
        self.calls.append(("ack", task["task_id"], task["lease_token"]))
        return {"ok": True}

    def renew(self, task):
        self.calls.append(("renew", task["task_id"]))
        return {"ok": True}

    def result(self, task, result):
        self.calls.append(("result", task["task_id"], result["status"]))
        return {"ok": True}


class RelayAgentTests(unittest.TestCase):
    def test_once_acknowledges_runs_and_reports_result(self):
        with tempfile.TemporaryDirectory() as directory:
            config = AgentConfig(
                worker_url="https://relay.test",
                agent_id="codex-local-01",
                agent_key="unit-agent-fixture",
                working_directories={"project": directory},
                state_file=str(Path(directory) / "state.json"),
                retry_file=str(Path(directory) / "outbox.json"),
            )
            task = {"task_id": "task-1", "lease_token": "lease-1", "working_directory_id": "project", "sandbox_mode": "read-only", "instruction": "inspect files", "approval_status": None}
            client = FakeClient(task)
            runner_calls = []

            def runner(_config, received, _timeout):
                runner_calls.append(received["task_id"])
                return {"status": "succeeded", "result_summary": "done"}

            agent = RelayAgent(config, client=client, runner=runner)
            self.assertTrue(agent.run_once())
            self.assertEqual(runner_calls, ["task-1"])
            self.assertEqual([call[0] for call in client.calls], ["heartbeat", "claim", "ack", "result", "heartbeat"])
            self.assertFalse(Path(config.state_file).exists())

    def test_remote_absolute_path_is_never_used(self):
        with tempfile.TemporaryDirectory() as directory:
            config = AgentConfig(worker_url="https://relay.test", agent_id="codex-local-01", agent_key="unit-agent-fixture", working_directories={"project": directory})
            with self.assertRaises(RelayError):
                resolve_working_directory(config, {"working_directory_id": directory, "instruction": "do not use"})

    def test_workspace_write_requires_local_flag_and_approval(self):
        with tempfile.TemporaryDirectory() as directory:
            config = AgentConfig(worker_url="https://relay.test", agent_id="codex-local-01", agent_key="unit-agent-fixture", working_directories={"project": directory}, allow_workspace_write=False)
            task = {"working_directory_id": "project", "sandbox_mode": "workspace-write", "approval_status": "approved", "instruction": "edit file"}
            with self.assertRaises(RelayError):
                execute_codex(config, task)

    def test_codex_invocation_uses_argument_array_and_read_only_sandbox(self):
        with tempfile.TemporaryDirectory() as directory:
            config = AgentConfig(worker_url="https://relay.test", agent_id="codex-local-01", agent_key="unit-agent-fixture", working_directories={"project": directory}, codex_command=("codex",))
            task = {"working_directory_id": "project", "sandbox_mode": "read-only", "approval_status": None, "instruction": "inspect files"}

            class Process:
                returncode = 0

                def communicate(self, timeout=None):
                    return "analysis", ""

            with patch("relay_agent.subprocess.Popen", return_value=Process()) as popen:
                result = execute_codex(config, task, timeout=10)
            command = popen.call_args.args[0]
            self.assertIn("--sandbox", command)
            self.assertIn("read-only", command)
            self.assertEqual(popen.call_args.kwargs["shell"], False)
            self.assertEqual(result["status"], "succeeded")


if __name__ == "__main__":
    unittest.main()
