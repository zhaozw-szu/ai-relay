import tempfile
import unittest
from pathlib import Path
import json
import threading
from unittest.mock import patch

from relay_agent import AgentConfig, RelayAgent, RelayError, execute_codex, resolve_working_directory


class FakeClient:
    def __init__(self, task, result_errors=None):
        self.task = task
        self.calls = []
        self.result_errors = list(result_errors or [])

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
        if self.result_errors:
            error = self.result_errors.pop(0)
            raise error
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

    def test_zero_exit_with_windows_runtime_error_is_not_success(self):
        with tempfile.TemporaryDirectory() as directory:
            config = AgentConfig(worker_url="https://relay.test", agent_id="codex-local-01", agent_key="unit-agent-fixture", working_directories={"project": directory}, codex_command=("codex",))
            task = {"working_directory_id": "project", "sandbox_mode": "read-only", "approval_status": None, "instruction": "inspect files"}

            class Process:
                returncode = 0

                def communicate(self, timeout=None):
                    return "", "Failed to create unified exec process: registered Core process has no package identity"

            with patch("relay_agent.subprocess.Popen", return_value=Process()):
                result = execute_codex(config, task, timeout=10)
            self.assertEqual(result["status"], "failed")
            self.assertEqual(result["error_code"], "completion_unconfirmed")
            self.assertIn("registered Core process has no package identity", result["result"]["stderr"])

    def test_zero_exit_without_completion_output_is_unconfirmed(self):
        with tempfile.TemporaryDirectory() as directory:
            config = AgentConfig(worker_url="https://relay.test", agent_id="codex-local-01", agent_key="unit-agent-fixture", working_directories={"project": directory}, codex_command=("codex",))
            task = {"working_directory_id": "project", "sandbox_mode": "read-only", "approval_status": None, "instruction": "inspect files"}

            class Process:
                returncode = 0

                def communicate(self, timeout=None):
                    return "", ""

            with patch("relay_agent.subprocess.Popen", return_value=Process()):
                result = execute_codex(config, task, timeout=10)
            self.assertEqual(result["status"], "failed")
            self.assertEqual(result["error_code"], "completion_unconfirmed")

    def test_successful_codex_result_is_retried_without_rerunning_codex(self):
        with tempfile.TemporaryDirectory() as directory:
            config = AgentConfig(worker_url="https://relay.test", agent_id="codex-local-01", agent_key="unit-agent-fixture", working_directories={"project": directory}, state_file=str(Path(directory) / "state.json"), retry_file=str(Path(directory) / "outbox.json"), dead_letter_file=str(Path(directory) / "dead.json"))
            task = {"task_id": "task-retry", "lease_token": "lease-retry", "working_directory_id": "project", "sandbox_mode": "read-only", "instruction": "inspect files", "approval_status": None}
            client = FakeClient(task, [RelayError("temporary network failure")])
            runner_calls = []

            def runner(_config, received, _timeout):
                runner_calls.append(received["task_id"])
                return {"status": "succeeded", "result_summary": "done"}

            agent = RelayAgent(config, client=client, runner=runner)
            self.assertTrue(agent.run_once())
            queued = json.loads(Path(config.retry_file).read_text(encoding="utf-8"))
            self.assertEqual(queued[0]["result"]["status"], "succeeded")
            self.assertEqual(runner_calls, ["task-retry"])
            self.assertTrue(agent.run_once() is False)
            self.assertEqual(runner_calls, ["task-retry"])
            self.assertEqual(json.loads(Path(config.retry_file).read_text(encoding="utf-8")), [])

    def test_permanent_result_failure_is_kept_in_dead_letter(self):
        with tempfile.TemporaryDirectory() as directory:
            config = AgentConfig(worker_url="https://relay.test", agent_id="codex-local-01", agent_key="unit-agent-fixture", working_directories={"project": directory}, state_file=str(Path(directory) / "state.json"), retry_file=str(Path(directory) / "outbox.json"), dead_letter_file=str(Path(directory) / "dead.json"))
            task = {"task_id": "task-dead", "lease_token": "lease-dead", "working_directory_id": "project", "sandbox_mode": "read-only", "instruction": "inspect files", "approval_status": None}
            client = FakeClient(task, [RelayError("lease expired", status=409), RelayError("lease expired", status=409)])
            agent = RelayAgent(config, client=client, runner=lambda *_: {"status": "succeeded", "result_summary": "done"})
            agent.run_once()
            agent.run_once()
            dead = json.loads(Path(config.dead_letter_file).read_text(encoding="utf-8"))
            self.assertEqual(dead[0]["reason"], "result_retry_failed")
            self.assertEqual(dead[0]["result"]["status"], "succeeded")

    def test_lease_loss_marks_execution_invalid_and_cancellation_terminates_process(self):
        with tempfile.TemporaryDirectory() as directory:
            config = AgentConfig(worker_url="https://relay.test", agent_id="codex-local-01", agent_key="unit-agent-fixture", working_directories={"project": directory}, heartbeat_interval_seconds=5)
            task = {"task_id": "task-lease", "lease_token": "lease-lease", "lease_expires_at": "2099-01-01T00:00:00+00:00"}
            class LeaseClient:
                def renew(self, _task):
                    raise RelayError("lease is gone", status=409)
            agent = RelayAgent(config, client=LeaseClient())
            agent._renew_stop.wait = lambda _seconds: False
            agent._renew_loop(task)
            self.assertTrue(agent._lease_lost.is_set())

            class Process:
                pid = None
                returncode = -9
                def __init__(self): self.killed = False
                def communicate(self, timeout=None): return "", ""
                def kill(self): self.killed = True
            process = Process()
            cancel = threading.Event(); cancel.set()
            task_for_run = {"working_directory_id": "project", "sandbox_mode": "read-only", "approval_status": None, "instruction": "inspect files"}
            with patch("relay_agent.subprocess.Popen", return_value=process):
                result = execute_codex(config, task_for_run, timeout=10, cancel_event=cancel)
            self.assertTrue(process.killed)
            self.assertEqual(result["error_code"], "lease_lost")

    def test_relative_state_paths_resolve_next_to_config_file(self):
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "agent.json"
            config_path.write_text(json.dumps({"worker_url": "https://relay.test", "agent_id": "codex-local-01", "agent_key": "fixture", "working_directories": {}}), encoding="utf-8")
            config = AgentConfig.from_file(config_path)
            self.assertEqual(Path(config.state_file), Path(directory) / "relay_agent_state.json")
            self.assertEqual(Path(config.retry_file), Path(directory) / "relay_agent_outbox.json")

    def test_corrupt_outbox_is_quarantined_instead_of_silently_discarded(self):
        with tempfile.TemporaryDirectory() as directory:
            outbox = Path(directory) / "outbox.json"
            outbox.write_text("not-json", encoding="utf-8")
            config = AgentConfig(worker_url="https://relay.test", agent_id="codex-local-01", agent_key="fixture", working_directories={}, retry_file=str(outbox), state_file=str(Path(directory) / "state.json"), dead_letter_file=str(Path(directory) / "dead.json"))
            agent = RelayAgent(config, client=FakeClient(None))
            self.assertEqual(agent._load_queue(), [])
            self.assertFalse(outbox.exists())
            self.assertTrue(list(Path(directory).glob("outbox.json.corrupt-*")))


if __name__ == "__main__":
    unittest.main()
