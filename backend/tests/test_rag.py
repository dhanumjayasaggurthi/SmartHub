import os

import pytest
from fastapi import HTTPException

import rag


def evidence(eid, source="s1", score=None):
    return rag.Evidence(
        evidence_id=eid,
        source_id=source,
        source_name=source,
        source_type="data_api",
        title=eid,
        text=f"supporting text {eid}",
        retrieval_score=score,
    )


def test_rrf_deduplicates_and_rewards_cross_leg_hits():
    a, b, c = evidence("a"), evidence("b"), evidence("c")
    ranked = rag.reciprocal_rank_fusion([[a, b], [c, a]])
    assert [x.evidence_id for x in ranked][0] == "a"
    assert len({x.evidence_id for x in ranked}) == 3
    assert ranked[0].retrieval_score > ranked[-1].retrieval_score


def test_profile_defaults_to_source_only_verification():
    cfg = rag._validate_profile({"source_ids": ["source-1"]})
    assert cfg["source_only"] is True
    assert cfg["verify"] is True
    assert cfg["require_verification"] is True
    assert cfg["repair_attempts"] == 1
    assert cfg["final_k"] <= cfg["candidate_k"]


def test_profile_rejects_unknown_or_browser_tools():
    with pytest.raises(HTTPException):
        rag._validate_profile({"source_ids": ["source-1"], "portal_tools": ["navigate_to"]})
    with pytest.raises(HTTPException):
        rag._validate_profile({"source_ids": ["source-1"], "portal_tools": ["does_not_exist"]})


def test_connector_source_rejects_unsafe_identifier():
    with pytest.raises(HTTPException):
        rag._validate_source("connector", {
            "source_system": "postgresql",
            "table": "documents; DROP TABLE x",
            "text_columns": ["text"],
        })


def test_rest_source_requires_https_allowlisted_host(monkeypatch):
    monkeypatch.setenv("RAG_ALLOWED_API_HOSTS", "api.example.test")
    good = rag._validate_source("rest", {
        "url": "https://api.example.test/search",
        "method": "GET",
        "text_field": "text",
        "secret_env": "RAG_SECRET_TEST",
    })
    assert good["method"] == "GET"

    with pytest.raises(HTTPException):
        rag._validate_source("rest", {
            "url": "http://api.example.test/search",
            "method": "GET",
            "text_field": "text",
        })
    with pytest.raises(HTTPException):
        rag._validate_source("rest", {
            "url": "https://169.254.169.254/latest/meta-data",
            "method": "GET",
            "text_field": "text",
        })


def test_generation_rejects_fabricated_citation():
    ev = evidence("ev_good")
    generated, errors = rag._validate_generated({
        "answer": "Claim [cite:ev_fake]",
        "claims": [{"text": "Claim", "evidence_ids": ["ev_fake"]}],
        "insufficient_evidence": False,
    }, [ev])
    assert "invalid_inline_citation" in errors
    assert "invalid_claim_citation" in errors
    assert generated["used_evidence_ids"] == []


def test_generation_accepts_resolvable_claim_and_citation():
    ev = evidence("ev_good")
    generated, errors = rag._validate_generated({
        "answer": "Claim [cite:ev_good]",
        "claims": [{"text": "Claim", "evidence_ids": ["ev_good"]}],
        "insufficient_evidence": False,
    }, [ev])
    assert errors == []
    assert generated["used_evidence_ids"] == ["ev_good"]


def test_verifier_failure_is_unavailable_not_verified():
    class Broken:
        class chat:
            class completions:
                @staticmethod
                def create(**kwargs):
                    raise RuntimeError("provider down")

    generated = {"claims": [{"text": "Claim", "evidence_ids": ["ev_good"]}]}
    result = rag._verify(Broken(), "gpt-4o", "question", generated, [evidence("ev_good")])
    assert result["state"] == "unavailable"


def test_citations_resolve_only_known_evidence():
    ev = evidence("ev_good")
    generated = {"used_evidence_ids": ["ev_good"]}
    citations = rag._citations(generated, [ev])
    assert citations[0]["evidence_id"] == "ev_good"
    assert citations[0]["source_id"] == "s1"


def test_generation_rejects_placeholder_answer():
    ev = evidence("ev_good")
    generated, errors = rag._validate_generated({
        "answer": "markdown",
        "claims": [{"text": "Claim", "evidence_ids": ["ev_good"]}],
        "insufficient_evidence": False,
    }, [ev])
    assert "placeholder_answer" in errors
    assert generated["answer"] == "markdown"


def test_presentation_blocks_are_grounded_in_evidence_metadata():
    ev1 = evidence("ev_one", score=0.04)
    ev1.title = "Document one"
    ev1.metadata = {"row": {"category": "Safety", "study_name": "ABC-101"}}
    ev2 = evidence("ev_two", score=0.03)
    ev2.title = "Document two"
    ev2.metadata = {"row": {"category": "Safety", "study_name": "ABC-101"}}
    ev3 = evidence("ev_three", score=0.02)
    ev3.title = "Document three"
    ev3.metadata = {"row": {"category": "Consent", "study_name": "XYZ-202"}}

    generated = {
        "claims": [
            {"text": "Safety evidence is available.", "evidence_ids": ["ev_one", "ev_two"]},
            {"text": "Consent evidence is available.", "evidence_ids": ["ev_three"]},
        ],
        "used_evidence_ids": ["ev_one", "ev_two", "ev_three"],
    }
    citations = rag._citations(generated, [ev1, ev2, ev3])
    blocks = rag._build_presentation(generated, [ev1, ev2, ev3], citations)

    kpi = next(block for block in blocks if block["type"] == "kpi")
    table = next(block for block in blocks if block["type"] == "table")
    chart = next(block for block in blocks if block["type"] == "chart" and block["audience"] == "business")

    assert {item["label"]: item["value"] for item in kpi["items"]}["Citations"] == 3
    assert table["rows"][0]["document"] == "Document one"
    assert chart["data"][0] == {"category": "Safety", "count": 2}


def test_citation_has_business_and_technical_views():
    ev = evidence("ev_good", score=0.1234)
    ev.title = "Clinical source record"
    ev.retrieval_method = "data_api_native"
    ev.locator = {"api_id": "api", "alias": "documents", "row": 1}
    ev.metadata = {"row": {"study_name": "ABC-101", "status": "Active"}}
    generated = {
        "claims": [{"text": "The study is active.", "evidence_ids": ["ev_good"]}],
        "used_evidence_ids": ["ev_good"],
    }

    citation = rag._citations(generated, [ev])[0]
    assert citation["business"]["record"]["study_name"] == "ABC-101"
    assert citation["business"]["supports"] == ["The study is active."]
    assert citation["technical"]["retrieval_method"] == "data_api_native"
    assert citation["technical"]["retrieval_score"] == 0.1234


def test_profile_accepts_dynamic_data_api_dataset_reference():
    cfg = rag._validate_profile({
        "datasets": [{"api_id": "api-1", "alias": "documents"}],
        "source_ids": [],
    })
    assert cfg["datasets"] == [{"api_id": "api-1", "alias": "documents"}]
    assert cfg["agentic_planning"] is True
    assert cfg["retrieval_retry_attempts"] == 1


def test_profile_accepts_compact_dataset_reference():
    cfg = rag._validate_profile({
        "datasets": ["rimdocs/documents"],
        "source_ids": [],
    })
    assert cfg["datasets"] == [{"api_id": "rimdocs", "alias": "documents"}]


def test_filter_operators_are_type_aware():
    assert "contains" in rag._filter_ops_for_kind("string")
    assert "gt" in rag._filter_ops_for_kind("number")
    assert "contains" not in rag._filter_ops_for_kind("number")
    assert rag._filter_ops_for_kind("bulk") == []


def test_plan_filter_validation_rejects_unknown_column():
    capability = {
        "dataset_id": "data_api:api:table",
        "name": "RIMDocs / documents",
        "columns": [
            {
                "name": "STATUS",
                "filterable": True,
                "filter_ops": ["eq", "ne", "in"],
            }
        ],
        "limits": {"max_filters": 10},
    }
    with pytest.raises(HTTPException):
        rag._validate_plan_filters(
            [{"dataset_id": capability["dataset_id"], "column": "DOES_NOT_EXIST", "operator": "eq", "value": "A"}],
            capability,
        )


def test_plan_filter_validation_accepts_typed_filter():
    capability = {
        "dataset_id": "data_api:api:table",
        "name": "RIMDocs / documents",
        "columns": [
            {
                "name": "STATUS",
                "filterable": True,
                "filter_ops": ["eq", "ne", "in"],
            }
        ],
        "limits": {"max_filters": 10},
    }
    result = rag._validate_plan_filters(
        [{"dataset_id": capability["dataset_id"], "column": "STATUS", "operator": "eq", "value": "Approved"}],
        capability,
    )
    assert result == [{
        "dataset_id": capability["dataset_id"],
        "column": "STATUS",
        "operator": "eq",
        "value": "Approved",
    }]


def test_wire_filter_preserves_colons_and_lists():
    assert rag._wire_filter({"column": "WHEN", "operator": "gte", "value": "2026-10-07T10:00:00"}) == (
        "WHEN:gte:2026-10-07T10:00:00"
    )
    assert rag._wire_filter({"column": "STATUS", "operator": "in", "value": ["Approved", "Pending"]}) == (
        "STATUS:in:Approved,Pending"
    )
    assert rag._wire_filter({"column": "DELETED_AT", "operator": "is_null", "value": None}) == (
        "DELETED_AT:is_null"
    )


def test_search_mode_availability_uses_discovered_capabilities():
    capability = {
        "search": {
            "text": {"enabled": True},
            "vector": {"enabled": True},
            "hybrid": {"enabled": False},
        }
    }
    assert rag._requested_mode_available("text", capability)
    assert rag._requested_mode_available("vector", capability)
    assert not rag._requested_mode_available("hybrid", capability)
