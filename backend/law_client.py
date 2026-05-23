from __future__ import annotations

import logging
import time
from typing import Any

import httpx

from backend.config import get_settings
from backend.hybrid_rag import LAW_DATABASE

logger = logging.getLogger(__name__)

LAW_SEARCH_URL = "https://www.law.go.kr/DRF/lawSearch.do"
LAW_DETAIL_URL = "https://www.law.go.kr/DRF/lawService.do"
TIMEOUT_SEC = 8.0
MAX_RETRIES = 2


def _local_search(query: str, limit: int = 3) -> list[dict[str, Any]]:
    """API 키 없음/실패 시 내장 법령 DB 키워드 검색."""
    results: list[dict[str, Any]] = []
    for doc in LAW_DATABASE:
        score = 0.0
        for kw in doc.get("keywords", []):
            if kw in query:
                score += 1.0
        if score > 0 or any(w in doc["content"] for w in query.split() if len(w) >= 2):
            results.append({
                "law_id": doc["id"],
                "title": f"{doc['category']} {doc['clause']}",
                "summary": doc["content"][:300],
                "source": "local_db",
                "score": score,
            })
    results.sort(key=lambda x: x.get("score", 0), reverse=True)
    return results[:limit]


def _request_with_retry(url: str, params: dict[str, Any]) -> dict[str, Any] | None:
    last_err: Exception | None = None
    for attempt in range(MAX_RETRIES + 1):
        try:
            with httpx.Client(timeout=TIMEOUT_SEC) as client:
                resp = client.get(url, params=params)
                resp.raise_for_status()
                data = resp.json()
                if isinstance(data, dict):
                    return data
        except Exception as exc:
            last_err = exc
            logger.warning("[LawAPI] attempt %s failed: %s", attempt + 1, exc)
            if attempt < MAX_RETRIES:
                time.sleep(0.3 * (attempt + 1))
    if last_err:
        logger.warning("[LawAPI] all retries failed: %s", last_err)
    return None


def search_related_laws(query: str, limit: int = 3) -> list[dict[str, Any]]:
    """
    국가법령정보센터 Open API 검색 (OC=LAW_API_KEY).
    실패 시 빈 결과가 아닌 local_db fallback.
    """
    query = (query or "").strip()
    if not query:
        return []

    settings = get_settings()
    oc = settings.law_api_key.strip()
    if settings.local_demo_mode or not oc:
        logger.info("[LawAPI] local_db fallback")
        return _local_search(query, limit)

    params = {
        "OC": oc,
        "target": "law",
        "type": "JSON",
        "query": query[:100],
        "display": limit,
    }
    data = _request_with_retry(LAW_SEARCH_URL, params)
    if not data:
        return _local_search(query, limit)

    laws_raw = data.get("LawSearch", data.get("law", []))
    if isinstance(laws_raw, dict):
        laws_raw = laws_raw.get("law", laws_raw.get("item", []))
    if not isinstance(laws_raw, list):
        laws_raw = [laws_raw] if laws_raw else []

    parsed: list[dict[str, Any]] = []
    for item in laws_raw[:limit]:
        if not isinstance(item, dict):
            continue
        law_id = str(item.get("법령ID") or item.get("lawId") or item.get("MST") or "")
        name = str(item.get("법령명한글") or item.get("lawName") or item.get("법령명") or "관련 법령")
        parsed.append({
            "law_id": law_id or f"LAW_{len(parsed)+1}",
            "title": name,
            "summary": str(item.get("법령내용") or item.get("content") or name)[:400],
            "source": "law.go.kr",
            "score": 1.0,
        })

    if not parsed:
        return _local_search(query, limit)
    return parsed


def get_law_summary(law_id: str) -> dict[str, Any]:
    """법령 ID로 요약 조회. 실패 시 local_db 매칭."""
    law_id = (law_id or "").strip()
    if not law_id:
        return {"law_id": "", "title": "", "summary": "", "source": "empty"}

    for doc in LAW_DATABASE:
        if doc["id"] == law_id:
            return {
                "law_id": law_id,
                "title": f"{doc['category']} {doc['clause']}",
                "summary": doc["content"],
                "source": "local_db",
            }

    settings = get_settings()
    oc = settings.law_api_key.strip()
    if settings.local_demo_mode or not oc:
        return {
            "law_id": law_id,
            "title": "법령 요약",
            "summary": "LAW_API_KEY 미설정으로 상세 조회를 생략합니다.",
            "source": "local_db",
        }

    params = {"OC": oc, "target": "law", "type": "JSON", "MST": law_id}
    data = _request_with_retry(LAW_DETAIL_URL, params)
    if not data:
        return {
            "law_id": law_id,
            "title": "법령 요약",
            "summary": "법령 API 조회 실패. 사내 DB 또는 수동 검토가 필요합니다.",
            "source": "fallback",
        }

    body = data.get("법령", data.get("law", data))
    if isinstance(body, dict):
        name = str(body.get("법령명한글") or body.get("lawName") or law_id)
        content = str(body.get("법령내용") or body.get("content") or name)
        return {
            "law_id": law_id,
            "title": name,
            "summary": content[:2000],
            "source": "law.go.kr",
        }

    return {
        "law_id": law_id,
        "title": law_id,
        "summary": "파싱 가능한 법령 본문이 없습니다.",
        "source": "fallback",
    }


if __name__ == "__main__":
    for law in search_related_laws("하도급 지식재산권"):
        print(law)
    print(get_law_summary("SUB_LAW_10"))
