"""Unit regression tests for generic pgvector halfvec expression discovery."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vector_index_strategy import halfvec_cast_index


def test_safe_catalog_casts():
    assert halfvec_cast_index("(question_embedding)::halfvec(3072)") == ("question_embedding", 3072)
    assert halfvec_cast_index('("Embedding Column")::public.halfvec(1800)') == ("Embedding Column", 1800)
    assert halfvec_cast_index("((embedding))::halfvec(768)") == ("embedding", 768)
    assert halfvec_cast_index('"MixedCase"::halfvec(4096)') is None


def test_unsafe_and_unrelated_index_expressions_are_ignored():
    for expression in (
        "substr(embedding, 1)::halfvec(3072)",
        "embedding::halfvec(3072) + 1",
        "coalesce(embedding, NULL)::halfvec(3072)",
        "embedding::vector(3072)",
        "embedding::halfvec(5000)",
        "(embedding + other_embedding)::halfvec(3072)",
        "embedding::halfvec(0)",
        "embedding::halfvec(3072); drop table x",
    ):
        assert halfvec_cast_index(expression) is None, expression
