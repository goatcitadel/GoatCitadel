"""Tests for the NPU sidecar bind/auth hardening (F-M7).

Run from the sidecar venv (the same environment that runs server.py):

    cd apps/npu-sidecar
    pip install -r requirements.txt pytest
    pytest
"""

import importlib

import pytest


def load_server(monkeypatch, env):
    for key in (
        "GOATCITADEL_NPU_AUTH_TOKEN",
        "GOATCITADEL_NPU_ALLOW_REMOTE",
        "GOATCITADEL_NPU_HOST",
        "GOATCITADEL_NPU_FALLBACK_URL",
    ):
        monkeypatch.delenv(key, raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    import server

    return importlib.reload(server)


def test_is_loopback_host_classification(monkeypatch):
    server = load_server(monkeypatch, {})
    assert server.is_loopback_host("127.0.0.1") is True
    assert server.is_loopback_host("::1") is True
    assert server.is_loopback_host("[::1]") is True
    assert server.is_loopback_host("localhost") is True
    assert server.is_loopback_host("0.0.0.0") is False
    assert server.is_loopback_host("::") is False
    assert server.is_loopback_host("192.168.1.10") is False


def test_resolve_listen_host_allows_loopback_by_default(monkeypatch):
    server = load_server(monkeypatch, {})
    assert server.resolve_listen_host("127.0.0.1") == "127.0.0.1"


def test_resolve_listen_host_rejects_remote_without_optin(monkeypatch):
    server = load_server(monkeypatch, {})
    with pytest.raises(RuntimeError):
        server.resolve_listen_host("0.0.0.0")


def test_resolve_listen_host_rejects_remote_optin_without_token(monkeypatch):
    server = load_server(monkeypatch, {"GOATCITADEL_NPU_ALLOW_REMOTE": "1"})
    with pytest.raises(RuntimeError):
        server.resolve_listen_host("0.0.0.0")


def test_resolve_listen_host_allows_remote_with_optin_and_token(monkeypatch):
    server = load_server(
        monkeypatch,
        {"GOATCITADEL_NPU_ALLOW_REMOTE": "true", "GOATCITADEL_NPU_AUTH_TOKEN": "secret"},
    )
    assert server.resolve_listen_host("0.0.0.0") == "0.0.0.0"


def test_inference_open_when_no_token_configured(monkeypatch):
    from fastapi.testclient import TestClient

    server = load_server(monkeypatch, {})
    with TestClient(server.app) as client:
        assert client.get("/health").status_code == 200
        # No token configured (loopback-only deployment): models endpoint is reachable.
        assert client.get("/v1/models").status_code == 200


def test_inference_requires_bearer_when_token_configured(monkeypatch):
    from fastapi.testclient import TestClient

    server = load_server(monkeypatch, {"GOATCITADEL_NPU_AUTH_TOKEN": "secret"})
    with TestClient(server.app) as client:
        # /health stays public for liveness probes.
        assert client.get("/health").status_code == 200
        # Protected routes reject missing/incorrect tokens and accept the correct one.
        assert client.get("/v1/models").status_code == 401
        assert client.get("/v1/models", headers={"Authorization": "Bearer wrong"}).status_code == 401
        assert client.get("/v1/models", headers={"Authorization": "Bearer secret"}).status_code == 200
        assert (
            client.post("/v1/chat/completions", json={"messages": [{"role": "user", "content": "hi"}]}).status_code
            == 401
        )
