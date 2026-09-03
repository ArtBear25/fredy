"""Deterministic condition evaluation without executable user code."""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

from app.models import Condition, RuleGroup


def resolve_path(context: Mapping[str, Any], path: str) -> Any:
    current: Any = context
    for part in path.split("."):
        if isinstance(current, Mapping):
            current = current.get(part)
        else:
            current = getattr(current, part, None)
        if current is None:
            return None
    return current


def _as_number(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int | float):
        return float(value)
    cleaned = re.sub(r"[^0-9,.-]", "", str(value))
    if "," in cleaned and "." in cleaned:
        if cleaned.rfind(",") > cleaned.rfind("."):
            cleaned = cleaned.replace(".", "").replace(",", ".")
        else:
            cleaned = cleaned.replace(",", "")
    elif "," in cleaned:
        cleaned = cleaned.replace(",", ".")
    try:
        return float(cleaned)
    except ValueError:
        return None


def evaluate_condition(condition: Condition, context: Mapping[str, Any]) -> bool:
    actual = resolve_path(context, condition.field)
    expected = condition.value
    operator = condition.operator

    if operator == "exists":
        return (actual is not None and actual != "") is bool(expected if expected is not None else True)
    if operator == "eq":
        return actual == expected
    if operator == "neq":
        return actual != expected
    if operator == "contains":
        return str(expected).casefold() in str(actual or "").casefold()
    if operator == "not_contains":
        return str(expected).casefold() not in str(actual or "").casefold()
    if operator == "matches":
        return re.search(str(expected), str(actual or ""), flags=re.IGNORECASE) is not None

    left = _as_number(actual)
    right = _as_number(expected)
    if left is None or right is None:
        return False
    comparisons = {
        "gt": left > right,
        "gte": left >= right,
        "lt": left < right,
        "lte": left <= right,
    }
    return comparisons[operator]


def evaluate_group(group: RuleGroup | None, context: Mapping[str, Any]) -> bool:
    if group is None or (not group.conditions and not group.groups):
        return True
    results = [evaluate_condition(condition, context) for condition in group.conditions]
    results.extend(evaluate_group(child, context) for child in group.groups)
    return all(results) if group.mode == "all" else any(results)
